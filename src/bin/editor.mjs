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
// M22: A SAVE WRITES BYTES TO THE FILE. It did not. The `y` above wrote `[saved]` to the WINDOW fd
// and nothing anywhere else, so a reader was told their edit was saved and it was not — a dishonest
// success, which is the worst failure this project has a name for (docs/PRD-SHELL.md R25). What a
// save is now:
//
//   ctrl-S                 write the DOCUMENT to `savePath`, `fsync` it, and read it back through a
//                          FRESH `open` before reporting a byte count. A failure says the path and
//                          the errno and reports NO success.
//   ctrl-shift-S           the SAVE AS dialog: an owned, BLOCKING window (M9's two axes again) with
//                          a name field, and ctrl-T raises its `Save as type` menu through M20's
//                          `win_menu` — a process's own popup, drawn by the shell, so the dialog
//                          needs no drawing capability it does not have.
//   y, in the close dialog the same save, then the close. The destination is NAMED in the question,
//                          so `y` is not a blind write to somewhere a reader never saw.
//
// THE DIALOG IS THIS PROGRAM'S AND IS NOT YET SHARED, which R25 asks for and this does not claim.
// It is the FIRST caller: one program's dialog is a dialog, and `src/libos/std.mjs` is where it
// belongs the moment a second program needs to name a file (`CLAUDE.md`: the second caller
// justifies the abstraction). Nothing here is copied from anywhere, so there is no second copy to
// reconcile today.
//
// THE DOCUMENT IS NOT THE SCREEN. The window is a transcript — it carries the prompt, the open
// error and `[still editing]` — and saving what is on it would write this program's own messages
// into the reader's file. `doc` is the bytes: the file's text when one was opened, plus what has
// been typed since. The screen gets CRLF because a terminal needs it (src/wm/terminal.mjs); the
// FILE gets LF.
//
// THERE IS NO UNNAMED DOCUMENT. `savePath` is set before the first key arrives — the operand, or
// `std.sessionDir`'s directory plus `DEFAULT_NAME` — and it is printed where a reader will see it.
// A program that waited until the save to decide where the bytes go is a program whose "saved"
// means a different place on different volumes. `sessionDir` falls back to the read-only base
// (`MNT_RO`, `mutErrno: EROFS`), and the fallback is NOT replaced here with somewhere writable: a
// save there refuses by errno, which is the truth, and Save As is the way out of it.
//
// THREE FLAGS, AND NONE BELONGS ON A PROMPT. The first two open an extra window that exists to show
// a rule rather than to be useful, so the PRODUCT path — `editor <path>`, which is what the file
// association runs for a `.txt` or `.md` — opens exactly ONE window:
//
//   -a   a second window of this process, so an APP-modal dialog can be seen blocking it where a
//        WINDOW-modal one does not. That difference is the whole reason there are two axes.
//   -p   the tool PALETTE: owned, RENDER_ABOVE, blocking nothing. It is the only thing that shows
//        the owner CHAIN apart from modality. It was unconditional until a reader pointed out that
//        opening a text file put a second window on their desktop; `www/m9.html` passes it now.
//   --save-to-window-fd
//        THE NEGATIVE CONTROL, restoring the defect above: every save reports the byte count it
//        would have written and writes `[saved]` to the window fd instead of the file. Every
//        drawing clause MUST still hold under it — the dialog, the cascade, the reported count —
//        because that is exactly how the defect shipped, and only a fresh `open` tells the two
//        worlds apart. A flag and not a source mutation, for `scripts/serve.py --no-isolation`'s
//        reason: a control nobody can re-run is a control nobody re-runs.
//
// M16: EVERY WINDOW THIS PROGRAM OPENS IS A TEXT WINDOW, so it answers no `WEV_CLIENT` and calls
// none of `src/libos/std.mjs`'s re-surface helpers. The `WEV_CLIENT` branch below states
// what asking for a surface here would cost, because a reader diffing M16 across the other four
// programs will come looking for the call that is absent.

import {
  POLLIN, POLLHUP, POLLERR, POLLNVAL, EINTR, EHOSTGONE, EIO,
  O_WRONLY, O_CREAT, O_TRUNC, NAME_MAX,
  WEV_KEY, WEV_CLOSE, WEV_DESTROYED, WEV_RESIZE, WEV_FOCUS, WEV_CLIENT, WEV_ITEM,
  WMODAL_NONE, WMODAL_WINDOW, WMODAL_APP, WMODE_BLOCKING, WMODE_RENDER_ABOVE,
  WMOD_SHIFT, WITEM_CONTEXT,
  keyBytesOf, itemAt,
} from "/src/abi.mjs";

const NAME = "editor";

const POLL_MS = 200;
const CEILING_MS = 120000;

/** The mode a saved file is created with. 0o644 is `std`'s own default for `open` and `touch`'s
 *  `DEFAULT_MODE`; a document is not executable. */
const SAVE_MODE = 0o644;

/** The name a document gets when the caller named no file. The EXTENSION matters and is not
 *  decoration: `std.OPENS_FILES` routes `.txt` back to this program, so a saved document is one the
 *  file association can re-open (constraint 290's rule for a row a reader can use). */
const DEFAULT_NAME = "untitled.txt";

/* THE BYTE KEYS THIS PROGRAM BINDS, AND IT BINDS NOTHING ELSE — EVERY WINDOW HERE IS A TEXT
 * WINDOW, AND A TEXT WINDOW RECEIVES NO KEYSYM.
 *
 * MEASURED, because the obvious key for the type list is Windows 7's own F4 and it does not arrive:
 * `Terminal.#key` returns early when `bytesForKey` produced no bytes (`src/wm/terminal.mjs:80-81`),
 * so the press is dropped by the widget, and `keysymForKey` is consulted only in the SURFACE's key
 * handler (`src/wm/winhost.mjs:923`). A real F4 into this dialog left `WinHost.stats.menus` at 0 —
 * no `win_menu` was ever called. M18's keysyms are a surfaced window's; `src/bin/files.mjs` gets F2
 * and Delete because it draws pixels. A program that advertised F4 here would be advertising a key
 * the system cannot deliver, which is the live-looking-button defect with an accelerator attached.
 *
 * So: Enter is 10, Backspace is 127, Escape is 27 and a Ctrl chord is its C0 byte — Ctrl+A is 1, so
 * Ctrl+S is 19 and Ctrl+T is 20. CTRL+LETTER IS THE BROWSER'S ON WINDOWS and is not on macOS, where
 * its own chords are Command-based; that bill is `src/bin/files.mjs`'s Ctrl+N (new window) already,
 * and this project's measured platform is macOS. The dialog LABELS the key it binds, so a reader is
 * told which one rather than guessing. */
const KEY_ENTER = 10;
const KEY_ESCAPE = 27;
const KEY_BACKSPACE = 127;
const KEY_CTRL_S = 19;
const KEY_CTRL_T = 20;

/** The first byte this program types into a document. Below it are the C0 controls, which Enter and
 *  Backspace are handled out of above: a stray control byte in a file is a byte no reader can see
 *  and none can retype. A byte ABOVE 0x7e is a UTF-8 lead or continuation and is kept — `std.text`
 *  decodes the sequence `keyBytesOf` carried. */
const PRINTABLE_LO = 0x20;

/** What the close dialog asks, with the DESTINATION in it. A function and not a constant because
 *  `y` writes to that path: a question that said "save and close" without saying where is an
 *  instruction a reader cannot check before they follow it. */
function askText(dest) {
  return [
    "",
    "  Save changes before closing?",
    "",
    `    y   save and close   ->  ${dest}`,
    "    n   close without saving",
    "    Esc keep editing",
    "",
  ].join("\r\n");
}

/* THE SAVE AS DIALOG'S LABELS, and both are load-bearing rather than cosmetic. `SA_TYPE` is how the
 * type line is FOUND again when the menu is raised — the popup's point is derived from the text that
 * was written, so the two cannot drift — and its length is the column the type's value starts at.
 * `SA_NAME` ends the block, so a typed byte lands on the name field and `\b` erases from it. */
const SA_TYPE = "  type   ";
const SA_NAME = "  name   ";

const SA_W = 420;
const SA_H = 210;
const SA_X = 210;
const SA_Y = 250;

/** A string with its last CHARACTER removed, not its last code unit: `slice(0, -1)` on a surrogate
 *  pair leaves half of one, and half a character is bytes no decoder reads back. One Backspace, one
 *  erased cell, in both of the places this program accepts one. */
function dropLast(s) {
  const chars = Array.from(s);
  chars.pop();
  return chars.join("");
}

function unInterrupted(call) {
  const first = call();
  if (first !== -EINTR) return first;
  return call();
}

export function run(env) {
  const argv = (env.argv || []).map(String);
  /* THE LONG FLAG IS TAKEN OUT BEFORE `getopt` SEES IT, which is `src/bin/files.mjs`'s pre-pass
   * verbatim: `getopt` reads `--save-to-window-fd` as the single letters of its spelling and
   * refuses `-s` as unknown. `--` still ends the options, so a file whose name begins with a dash
   * is reachable. */
  let toWindowFd = false;
  const rest = [];
  let endOfOptions = false;
  for (const arg of argv.slice(1)) {
    if (!endOfOptions) {
      if (arg === "--") { endOfOptions = true; rest.push(arg); continue; }
      if (arg === "--save-to-window-fd") { toWindowFd = true; continue; }
    }
    rest.push(arg);
  }
  const { flags, operands, bad, why: badWhy } = env.std.getopt(rest, "ap");
  if (bad) return env.std.complain(env, NAME, bad, badWhy, env.std.EXIT_USAGE);
  /* ONE FILE, AND A SECOND IS REFUSED RATHER THAN DROPPED. There is one window, one document and
   * one `savePath`: a caller that named two files and was shown the first would have the second
   * silently ignored, and a ctrl-S afterwards would write over the one they were looking at. */
  if (operands.length > 1) {
    return env.std.complain(env, NAME, operands[1], "only one file can be opened at a time",
      env.std.EXIT_USAGE);
  }
  /** `-a` makes the dialog APP-modal rather than window-modal, which blocks EVERY window of the
   *  owner's process rather than just the one it belongs to. The difference is only visible with a
   *  second window, which this program opens under `-a` so there is something to block. */
  const appModal = flags.a === true;
  /* `-p`: open the tool PALETTE. A fixture for M9's owner-chain proof and not a product feature —
   * see the palette's own block below for what leaving it unconditional cost a reader. */
  const wantPalette = flags.p === true;
  const t0 = performance.now();
  const account = {
    program: NAME, win: 0, fd: 0, second: 0, dialog: 0, palette: 0, saveAs: 0,
    typed: "", keys: 0, closes: 0, refusals: 0, clients: 0, suppressedWhileModal: 0,
    opened: "", openError: "",
    /* THE SAVE'S OWN RECORD. `saved` is one row per write that was read back and matched;
     * `saveErrors` is one row per refusal, BY ERRNO NAME, because "it did not save" passes for a
     * save that failed for the wrong reason (M3's `truncate`). `toWindowFd` is reported so a check
     * can assert the control was armed rather than infer it from the bytes it did not find. */
    savePath: "", saved: [], saveErrors: [], saveFailures: 0, docBytes: 0,
    toWindowFd, windowFdSaves: 0,
    /* THE SAVE AS DIALOG'S. `menus` counts `win_menu` raises, `typePicks` the rows that came back,
     * `dismissals` the menus closed with nothing picked, and `nameFaults` the names refused before
     * any call was made. */
    menus: 0, refusedMenus: 0, typePicks: 0, dismissals: 0, nameFaults: 0,
    saveAsOpened: 0, saveAsCancels: 0,
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
   * THE DOCUMENT. The file's text when one was opened, plus what has been typed since — and the
   * ONLY thing a save writes. The screen is a transcript and is not this (see the header).
   *
   * LF AND NOT CRLF. The screen gets CRLF because a bare LF leaves a terminal's cursor in the
   * column it was in (`src/wm/terminal.mjs`); the FILE gets what a text file in this system holds,
   * which is what `std.lines` and every program in `/usr/bin` splits on.
   */
  let doc = "";

  /**
   * M14. AN OPERAND OPENS A FILE, which is what a double-click on a text icon has to mean: the
   * desktop names a path and this program shows what is in it.
   *
   * M22. IT IS NOW LOADED FOR EDITING, because it can be saved: the bytes become the document and
   * `savePath` is the file they came from, so ctrl-S writes them back where they were. An operand
   * whose open FAILED is still the destination — a named path that is not there yet is a new file
   * and `O_CREAT` is what makes it one — and the errno is on the screen either way.
   *
   * WHERE A DOCUMENT WITH NO OPERAND GOES, decided HERE rather than at the save (see the header):
   * `std.sessionDir` is the one definition of where a program lands, and its `why` is non-empty
   * exactly when the fallback was taken. The fallback is the read-only base, so that path's save
   * answers EROFS by name rather than being quietly redirected somewhere writable.
   */
  const opening = operands[0] || "";
  const home = env.std.sessionDir(env);
  let savePath = opening || `${home.dir}/${DEFAULT_NAME}`;
  account.savePath = savePath;
  if (opening) {
    const body = env.std.readFileText(env, opening);
    account.opened = opening;
    if (typeof body === "number") {
      account.openError = env.std.errnoName(body);
      env.fs.write(made.fd, env.std.bytes(
        `${NAME}: ${opening}: ${env.std.errnoName(body)}\r\n`));
    } else {
      doc = body;
      env.win.setTitle(made.fd, `${NAME} — ${opening}`);
      // CRLF, because a window is a terminal-shaped surface and a bare LF leaves the cursor in
      // the column it was in (`src/wm/terminal.mjs`).
      env.fs.write(made.fd, env.std.bytes(
        `${opening}\r\n\r\n${body.replace(/\n/g, "\r\n")}\r\n`));
    }
  } else {
    env.fs.write(made.fd, env.std.bytes(
      `${NAME}: win ${made.win} on fd ${made.fd}\r\n`
      + "type something, then press the X on this window.\r\n"));
  }
  /* WHERE A SAVE GOES, SAID BEFORE ONE HAPPENS, and the PROMPT comes after it so the hint is not
   * sitting on a line that looks like something a reader typed. `why` names the fallback when it
   * was taken: a reader whose session tree is missing is about to meet EROFS, and the reason is
   * not their typo. */
  env.fs.write(made.fd, env.std.bytes(
    `\r\nctrl-S saves to ${savePath}. ctrl-shift-S saves somewhere else.`
    + `${home.why ? `  (no session tree: ${home.why})` : ""}\r\n\r\n> `));

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
  /** The open Save As dialog, or null: `{ fd, win, dir, stem, ext, top, typeAt, menu }`. `top` is
   *  how many lines have been written to it, which is what makes `typeAt` a CELL the popup can be
   *  raised at — see `writeSaveAs`. */
  let saveAs = null;

  /**
   * THE TYPES A SAVE MAY TAKE, derived from `std.OPENS_FILES` and not listed here.
   *
   * The association is one table in userland (`src/libos/std.mjs`), and the rule this applies to it
   * is the only honest one available: offer the extensions that route BACK to this program, so a
   * document saved from the type menu is one a double-click re-opens here. A list written in this
   * file would be how `.md` comes to be offered by the editor and opened by something else.
   */
  const TYPES = Object.keys(env.std.OPENS_FILES)
    .filter((ext) => env.std.OPENS_FILES[ext].prog === NAME)
    .map((ext) => `.${ext}`);

  /** Two byte arrays, compared. The read-back's whole point is that it is a comparison and not a
   *  length check: a torn write that kept the length is the case a length test passes. */
  const sameBytes = (a, b) => {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
    return true;
  };

  /**
   * THE DOCUMENT'S BYTES ONTO A PATH, or a NEGATIVE ERRNO. No message, no accounting: this is the
   * I/O, and the decision about what to tell the reader is `commitSave`'s.
   *
   * `fsync` IS A SEPARATE CALL (constraint 23). A write is buffered — `flush()` is 260 us against a
   * 5 us write — so a save that did not ask for durability is a save a reload can lose, which is
   * the same dishonest success in a slower form.
   *
   * A SHORT WRITE WITH NO PROGRESS IS -EIO. `std`'s `write` already loops to `MAX_INLINE` chunks and
   * returns early only when the sink stopped taking bytes, so a count short of the document is a
   * file holding a PREFIX of it and must not be reported as a save.
   */
  const writeWhole = (path, data) => {
    const fd = env.fs.open(path, O_WRONLY | O_CREAT | O_TRUNC, SAVE_MODE);
    if (fd < 0) return fd;
    let rc = env.fs.write(fd, data);
    if (rc >= 0 && rc !== data.length) rc = -EIO;
    if (rc >= 0) {
      const flushed = env.fs.fsync(fd);
      if (flushed < 0) rc = flushed;
    }
    env.fs.close(fd);
    return rc < 0 ? rc : data.length;
  };

  /**
   * THE ONE PLACE A SAVE HAPPENS. Returns the byte count that is now in the file, or a negative
   * errno. Every caller — ctrl-S, the close dialog's `y`, the Save As dialog's Enter — comes
   * through here, so there is one definition of what "saved" means.
   *
   * IT READS THE FILE BACK THROUGH A FRESH `open`, and that is the clause this row exists for. A
   * `write` that returned the right count says the ABI accepted the bytes; only an independent read
   * says they are in the file, and the difference is precisely the defect being retired. The
   * comparison is of BYTES, not of a length (`sameBytes`).
   *
   * `--save-to-window-fd` IS THE WORLD WHERE IT DOES NOT. It writes `[saved]` to the window fd and
   * reports the count it WOULD have written, so every message, every count and every frame reads
   * identically and only a reader's own `open` can tell the two apart. That is how the defect
   * shipped, and a control that also changed the reported number would be a control a drawing
   * clause could notice.
   */
  const commitSave = (path) => {
    const data = env.std.bytes(doc);
    if (toWindowFd) {
      env.fs.write(made.fd, env.std.bytes("\r\n[saved]\r\n"));
      account.windowFdSaves += 1;
      return data.length;
    }
    const wrote = writeWhole(path, data);
    if (wrote < 0) return wrote;
    const back = env.std.readFileBytes(env, path);
    if (typeof back === "number") return back;
    if (!sameBytes(back, data)) return -EIO;
    return wrote;
  };

  /** A refusal, BY PATH AND BY ERRNO NAME, recorded and said on stderr — and NOT as a success. The
   *  errno's NAME and not its number, because that is what a reader and a check both read. Returns
   *  the name, so the caller writes it where the reader is looking: the editor's screen for ctrl-S,
   *  the dialog's own field for Save As. */
  const noteSaveError = (path, r) => {
    const named = env.std.errnoName(r);
    account.saveErrors.push({ path, errno: named });
    account.saveFailures += 1;
    env.std.warn(env, `${NAME}: ${path}: ${named}\n`);
    return named;
  };

  /** The refusal as the EDITOR reports it. The reachable world is a read-only mount: `/usr` is
   *  `MNT_RO` with `mutErrno: EROFS`, so `editor /usr/share/readme.txt` plus ctrl-S is the whole of
   *  it. */
  const refuseSave = (path, r) => {
    const named = noteSaveError(path, r);
    env.fs.write(made.fd, env.std.bytes(`\r\n${NAME}: ${path}: ${named} — NOT saved\r\n> `));
    return false;
  };

  /** Save to the current destination. True only when the bytes are in the file. */
  const saveNow = () => {
    const r = commitSave(savePath);
    if (r < 0) return refuseSave(savePath, r);
    dirty = false;
    account.saved.push({ path: savePath, bytes: r });
    env.fs.write(made.fd, env.std.bytes(`\r\n[saved ${r} byte(s) to ${savePath}]\r\n> `));
    env.std.say(env, `${NAME}: saved ${r} byte(s) to ${savePath}\n`);
    return true;
  };

  /**
   * WRITE A BLOCK TO THE SAVE AS DIALOG, AND LOCATE ITS TYPE LINE IN CELLS.
   *
   * `win_menu` takes the WINDOW's own unit, which for a window with no surface is CELLS (constraint
   * 248, `WinHost.#clientPointAt`) — so the popup's point has to be a row and a column of this
   * window's text. It is DERIVED from the block that was written rather than declared beside it:
   * `SA_TYPE` is found in the lines, its index is the row and its length is the column, so moving a
   * line of the dialog cannot move the menu off the value it changes.
   *
   * `top` COUNTS LINES PUSHED, and the last line of a block is deliberately left as the CURRENT
   * line: joining with CRLF pushes `length - 1` of them, so the name field is where a typed byte
   * lands and where `\b` erases from.
   */
  const writeSaveAs = (block) => {
    const idx = block.findIndex((line) => line.startsWith(SA_TYPE));
    if (idx >= 0) saveAs.typeAt = { col: SA_TYPE.length, row: saveAs.top + idx };
    saveAs.top += block.length - 1;
    env.fs.write(saveAs.fd, env.std.bytes(block.join("\r\n")));
  };

  /** The type line, and the ONE place the accelerator it advertises is written. `writeSaveAs` finds
   *  this line again by its label to place the popup, so the two readers are one string. */
  const saveAsTypeLine = () => `${SA_TYPE}${saveAs.ext}    ctrl-T for the list`;

  const saveAsHead = () => [
    "",
    "  Save As",
    "",
    `  folder ${saveAs.dir}`,
    saveAsTypeLine(),
    "",
    "  Enter saves. Esc cancels. Backspace deletes.",
    "",
    `${SA_NAME}${saveAs.stem}`,
  ];

  /** The name field alone, re-written under whatever was said above it. */
  const saveAsField = () => ["", `${SA_NAME}${saveAs.stem}`];

  /**
   * THE SAVE AS DIALOG: owned by the editor and BLOCKING, which is M9's two axes used rather than
   * demonstrated — a name being typed must not race the document it is about to become.
   *
   * `win_create` THEN `win_set`, in that order and as two calls, for the close dialog's reason: a
   * window must never be modal for an instant before its owner is known.
   */
  const openSaveAs = () => {
    // THE CLOSE DIALOG HOLDS THE KEYBOARD WHILE IT IS UP (the kernel suppresses input to a blocked
    // window), so this cannot be reached from there — and a second Save As over the first would be
    // two name fields with one document.
    if (saveAs || dialog) return 0;
    const cut = savePath.lastIndexOf("/");
    const dir = cut > 0 ? savePath.slice(0, cut) : "/";
    const base = savePath.slice(cut + 1);
    const ext = env.std.extOf(base);
    const d = env.win.create({
      title: `${NAME} — Save As`, owner: made.win, w: SA_W, h: SA_H, x: SA_X, y: SA_Y,
    });
    if (typeof d === "number") return d;
    const r = env.win.setModal(d.fd, appModal ? WMODAL_APP : WMODAL_WINDOW, WMODE_BLOCKING);
    if (r < 0) {
      env.win.destroy(d.fd);
      return r;
    }
    saveAs = {
      fd: d.fd,
      win: d.win,
      dir,
      /* THE STEM AND THE TYPE ARE SPLIT BY `std.extOf`, the one definition of that split: a name
       * with no extension keeps its whole self as the stem and takes the first offered type, so the
       * field never shows a dot a reader did not type. */
      stem: ext ? base.slice(0, base.length - ext.length - 1) : base,
      ext: ext ? `.${ext}` : (TYPES[0] || ""),
      top: 0,
      typeAt: null,
      menu: null,
    };
    account.saveAs = d.win;
    account.saveAsOpened += 1;
    writeSaveAs(saveAsHead());
    return 0;
  };

  const closeSaveAs = () => {
    if (!saveAs) return;
    env.win.destroy(saveAs.fd);
    saveAs = null;
  };

  /** What is wrong with a name, or "". A NAME AND NOT A PATH: a slash would silently move the save
   *  to another directory, which is the folder line above the field saying something untrue.
   *  `NAME_MAX` is a BYTE count (`src/abi.mjs`), so the test encodes. */
  const nameFault = (name) => {
    if (name.length === 0) return "a name cannot be empty";
    if (name.includes("/")) return "a name cannot contain /";
    const n = env.std.bytes(name).length;
    if (n > NAME_MAX) return `a name is at most ${NAME_MAX} bytes, and that is ${n}`;
    return "";
  };

  /** THE TYPE MENU, RAISED AND NOT DRAWN. The rows are the ABI's three fields and the icon comes
   *  from `std.iconForPath` — userland's one table of which picture a file gets — so the popup
   *  shows a `.txt` the same way the desktop and the file list do. Every row carries
   *  `WITEM_CONTEXT`, which is the publisher's statement about where its rows belong and what the
   *  report below tests. */
  const raiseTypeMenu = () => {
    if (!saveAs || !saveAs.typeAt) return;
    const rows = TYPES.map((ext) => ({
      // THE ICON OF THE FILE THIS ROW WOULD PRODUCE, asked of the name the row means rather than of
      // the extension alone: `iconForPath` takes a path, and the row's path is the one the field is
      // already holding.
      icon: env.std.iconForPath(`${saveAs.stem}${ext}`),
      flags: WITEM_CONTEXT,
      label: ext,
    }));
    const rc = env.win.menu(saveAs.fd, saveAs.typeAt.col, saveAs.typeAt.row, rows);
    if (rc < 0) {
      account.refusedMenus += 1;
      writeSaveAs(["", `  win_menu: ${env.std.errnoName(rc)}`, ...saveAsField()]);
      return;
    }
    saveAs.menu = TYPES.slice();
    account.menus += 1;
  };

  /** Enter in the Save As dialog. The dialog stays up when the save refused: a reader whose name
   *  was rejected needs the field they were typing in, not a vanished window and an errno. */
  const commitSaveAs = () => {
    const name = `${saveAs.stem}${saveAs.ext}`;
    const fault = nameFault(name);
    if (fault) {
      account.nameFaults += 1;
      writeSaveAs(["", `  ${fault}`, ...saveAsField()]);
      return;
    }
    const path = `${saveAs.dir}/${name}`;
    const r = commitSave(path);
    if (r < 0) {
      writeSaveAs(["", `  ${path}: ${noteSaveError(path, r)} — NOT saved`, ...saveAsField()]);
      return;
    }
    savePath = path;
    account.savePath = path;
    account.saved.push({ path, bytes: r });
    dirty = false;
    closeSaveAs();
    env.win.setTitle(made.fd, `${NAME} — ${path}`);
    env.fs.write(made.fd, env.std.bytes(`\r\n[saved ${r} byte(s) to ${path}]\r\n> `));
    env.std.say(env, `${NAME}: saved ${r} byte(s) to ${path}\n`);
  };

  /** Open the dialog, owned by the editor, BLOCKING at the chosen scope. The two calls are
   *  separate on purpose: `win_create` names the owner and `win_set` sets the modality, so a
   *  window is never modal for an instant before its owner is known. */
  const ask = () => {
    const d = env.win.create({
      title: "Save changes?", owner: made.win, w: 420, h: 170, x: 150, y: 120,
    });
    if (typeof d === "number") return d;
    const scope = appModal ? WMODAL_APP : WMODAL_WINDOW;
    const r = env.win.setModal(d.fd, scope, WMODE_BLOCKING);
    if (r < 0) {
      env.win.destroy(d.fd);
      return r;
    }
    env.fs.write(d.fd, env.std.bytes(askText(savePath)));
    dialog = d;
    account.dialog = d.win;
    return 0;
  };

  const windows = () => {
    const set = [{ fd: made.fd, events: POLLIN }];
    if (second) set.push({ fd: second.fd, events: POLLIN });
    if (palette) set.push({ fd: palette.fd, events: POLLIN });
    if (dialog) set.push({ fd: dialog.fd, events: POLLIN });
    if (saveAs) set.push({ fd: saveAs.fd, events: POLLIN });
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
      const isSaveAs = saveAs && row.fd === saveAs.fd;
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
          if (isSaveAs) {
            // The X on the Save As dialog abandons the save and nothing else. The document is
            // untouched and still dirty, so the editor's own X will ask again.
            closeSaveAs();
            account.saveAsCancels += 1;
            continue;
          }
          /* A CLOSE REQUEST REACHES A BLOCKED WINDOW — the kernel suppresses keys and pointers to
           * one, never a close, a resize or a destroy notice — so this is reachable with the Save
           * As dialog up, and answering it would put a second modal over the first with one
           * document between them. It is refused where the reader is looking. */
          if (saveAs) {
            account.refusals += 1;
            writeSaveAs(["", "  finish or cancel this Save As first.", ...saveAsField()]);
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
        /**
         * M20. A ROW OF THE TYPE MENU WAS PICKED, OR THE MENU WAS CLOSED WITH NOTHING PICKED.
         *
         * `itemAt` IS WHAT MAKES A DISMISSAL ARRIVE AS ONE: `a` is read with `getUint32`, so the
         * kernel's `-1` reads back as 4,294,967,295 raw, and the test is `index < 0` rather than
         * `=== -1` so a second reason to close a menu needs no second comparison here.
         *
         * `where` IS TESTED AND NOT ASSUMED. This program publishes no `win_items`, so a report
         * without `WITEM_CONTEXT` indexes a list it never sent.
         */
        if (ev.type === WEV_ITEM) {
          if (!isSaveAs) continue;
          const picked = itemAt(ev);
          const offered = saveAs.menu;
          saveAs.menu = null;
          if (!(picked.where & WITEM_CONTEXT)) continue;
          if (picked.index < 0) {
            account.dismissals += 1;
            continue;
          }
          const ext = offered ? offered[picked.index] : null;
          if (!ext) continue;
          account.typePicks += 1;
          saveAs.ext = ext;
          writeSaveAs([saveAsTypeLine(), "", `${SA_NAME}${saveAs.stem}`]);
          continue;
        }
        if (ev.type !== WEV_KEY) continue;
        /* NO KEYSYM BRANCH, AND ITS ABSENCE IS MEASURED rather than an oversight: every window this
         * program opens is a TEXT window, and a text window delivers no keysym at all (see
         * `KEY_CTRL_T`'s block above). `keysymOf` is not even read here, because a counter that can
         * only ever report 0 is a reader's time spent on a path that does not exist. */
        const bytes = keyBytesOf(ev);
        if (bytes.length === 0) continue;
        account.keys += 1;
        if (isDialog) {
          const ch = String.fromCharCode(bytes[0]);
          if (ch === "y" || ch === "n") {
            /* `y` SAVES BEFORE IT CLOSES, AND DOES NOT CLOSE IF THE SAVE REFUSED. This is the row's
             * whole point: the close was asked for, the bytes did not reach the file, and a window
             * that went away anyway would be the dishonest success with the reader's work attached.
             * The errno is already on the editor's screen by name (`refuseSave`). */
            if (ch === "y" && !saveNow()) {
              env.win.destroy(dialog.fd);
              dialog = null;
              account.refusals += 1;
              continue;
            }
            // DESTROYING THE OWNER TAKES THE DIALOG WITH IT (M7's cascade), so this is one call
            // and the ids it returns say both went.
            const ids = env.win.destroy(made.fd);
            account.destroyed = Array.isArray(ids) ? ids : [];
            account.why = ch === "y" ? "saved and closed" : "closed without saving";
            dialog = null;
            break;
          }
          if (bytes[0] === KEY_ESCAPE) {
            // ESC: THE REFUSAL. The dialog goes, the editor stays, and the close that was asked
            // for did not happen.
            env.win.destroy(dialog.fd);
            dialog = null;
            account.refusals += 1;
            env.fs.write(made.fd, env.std.bytes("\r\n[still editing]\r\n> "));
          }
          continue;
        }
        if (isSaveAs) {
          /* THE NAME FIELD TAKES ALL OF THE KEYBOARD, which is `src/bin/files.mjs`'s rename box
           * rule: Enter commits, Esc abandons, Backspace deletes and a printable byte is typed.
           * Everything else is swallowed rather than passed through, because a ctrl-S that reached
           * the editor from here would save to the path this dialog is in the middle of changing. */
          const field = bytes[0];
          if (field === KEY_ENTER) { commitSaveAs(); continue; }
          if (field === KEY_CTRL_T) { raiseTypeMenu(); continue; }
          if (field === KEY_ESCAPE) {
            closeSaveAs();
            account.saveAsCancels += 1;
            continue;
          }
          if (field === KEY_BACKSPACE) {
            if (saveAs.stem.length > 0) {
              saveAs.stem = dropLast(saveAs.stem);
              // `\b` space `\b` ERASES. The widget overwrites at the cursor, so the space is what
              // clears the cell and the second `\b` is what leaves the cursor on it.
              env.fs.write(saveAs.fd, env.std.bytes("\b \b"));
            }
            continue;
          }
          if (field >= PRINTABLE_LO) {
            const typed = env.std.text(bytes);
            saveAs.stem += typed;
            env.fs.write(saveAs.fd, env.std.bytes(typed));
          }
          continue;
        }
        /* THE EDITOR ITSELF. Typed text is echoed by this program — there is no pty here, so
         * nothing else would show it — and it is appended to the DOCUMENT in the same breath. The
         * two are different strings on purpose (see the header): the screen carries CRLF and this
         * program's own messages, the document carries LF and only what a reader put there. */
        const b = bytes[0];
        if (b === KEY_CTRL_S) {
          /* CTRL-SHIFT-S IS SAVE AS, and the SHIFT is read off the record because it is not in the
           * byte: `bytesForKey` uppercases the letter before the C0 subtraction, so ctrl-S and
           * ctrl-shift-S are both byte 19 and `mods` is the only thing that tells them apart
           * (`src/wm/terminal.mjs`, `WinHost.modifierBits`). */
          if (ev.mods & WMOD_SHIFT) {
            const opened = openSaveAs();
            if (opened < 0) {
              account.refusals += 1;
              env.fs.write(made.fd, env.std.bytes(
                `\r\n${NAME}: Save As: ${env.std.errnoName(opened)}\r\n> `));
            }
          } else {
            saveNow();
          }
          continue;
        }
        if (b === KEY_BACKSPACE) {
          if (doc.length > 0) {
            doc = dropLast(doc);
            dirty = true;
            env.fs.write(made.fd, env.std.bytes("\b \b"));
          }
          continue;
        }
        if (b !== KEY_ENTER && b < PRINTABLE_LO) continue;
        dirty = true;
        const ch = b === KEY_ENTER ? "\r\n" : env.std.text(bytes);
        doc += b === KEY_ENTER ? "\n" : ch;
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
  if (saveAs) env.win.destroy(saveAs.fd);
  if (palette) env.win.destroy(palette.fd);
  if (second) env.win.destroy(second.fd);
  const left = env.win.destroy(made.fd);
  account.left = Array.isArray(left) ? left : [];
  account.ms = performance.now() - t0;
  // THE DOCUMENT'S SIZE AS IT ENDED, in BYTES — the unit a save is counted in, so a report whose
  // `saved` rows are short of it says the last edit was never written.
  account.docBytes = env.std.bytes(doc).length;
  env.std.say(env, `${NAME}: ${account.why}. ${account.keys} keys, ${account.closes} close `
    + `request(s), ${account.refusals} refused, ${account.saved.length} save(s), `
    + `${account.saveFailures} refused by the filesystem\n`);
  return { exit: 0, ...account };
}
