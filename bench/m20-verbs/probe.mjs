// M20's SIX VERBS AND TWO MENUS, under plain Node, against a fake filesystem and a fake window.
//
//   node --experimental-loader ./bench/m20-verbs/loader.mjs bench/m20-verbs/probe.mjs
//   node --experimental-loader ./bench/m20-verbs/loader.mjs bench/m20-verbs/probe.mjs --prove-failure
//
// What this CAN cover is the whole of what `docs/PLAN-SHELL.md` §M20 asks the verbs to prove:
// EVERY ONE OF THEM ASSERTS THE FILESYSTEM. A created directory is read back out of a fresh
// `readdir`, a rename moves the bytes to the new name and leaves nothing at the old one, a paste
// produces EQUAL BYTES, and every refusal is asserted by its OWN ERRNO rather than as one "it
// refused" — M3's `truncate` answered ENOENT where it owed EROFS, and a single refusal clause
// passes for that.
//
// What it CANNOT cover is the menu a reader can see. `win_menu` is asserted here as a CALL — its
// arguments, its unit and its refusals — and the popup itself is a DOM node the page builds, so
// whether it extends past `.window-body` is a pixel and belongs to the browser-driven page. That
// is also what `--menu-in-surface` is for, and this probe asserts the half of it that is reachable
// from here: under that flag NO `win_menu` reaches the kernel and the menu's labels appear in the
// DISPLAY LIST instead, which is the program's own admission that it drew its own popup.
//
// THE FAKES ARE NOT GENTLER THAN THE REAL THING (constraint 98), and three of them matter:
//
//   `rename` CLOBBERS its destination, exactly as `src/fs/vfs.mjs` does. That is the whole reason
//   `files` pre-checks: a fake that refused EEXIST on its own would let the program's pre-check be
//   deleted with every clause still green.
//   `open(O_CREAT | O_EXCL)` refuses EEXIST, so the copy half of Paste is refused by the FAKE
//   KERNEL and not by the program — the asymmetry the program documents.
//   A PUBLISHED data object is SEALED and `dataobj_set` on it answers -EPERM (constraint 242), so
//   a Cut that tried to write its intent back into what it had already published would fail here.
//
// `--prove-failure` inverts every expectation, so a run that reports no failures has not been
// checked (`CLAUDE.md`). It exits 0 when the proof SUCCEEDED.
import { run as runFiles, FILES_METRICS } from "../../src/bin/files.mjs";
import * as std from "../../src/libos/std.mjs";
import {
  E, S_IFMT, S_IFDIR, S_IFREG, O_DIRECTORY, O_CREAT, O_EXCL, O_ACCMODE, O_RDONLY, O_TRUNC,
  POLLIN, WEV_KEY, WEV_POINTER, WEV_ITEM, WPTR_DOWN, WPTR_UP, WPTR_CLICK2,
  WKEY_F2, WKEY_DELETE, WITEM_CONTEXT, WITEM_SEPARATOR, WITEM_DISABLED,
  packKeyBytes, DOBJ_PATHS, DOBJ_WHERE_CLIPBOARD, fmtBit, fmtsOf,
  DL_TEXT, textOfOps,
} from "../../src/abi.mjs";

const INVERT = process.argv.includes("--prove-failure");
const results = [];
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  results.push({ name, ok, got: ok ? undefined : got, want: ok ? undefined : want });
};
const checkThat = (name, cond, detail) =>
  results.push({ name, ok: !!cond, detail: cond ? undefined : detail });

/** A path's state as something COMPARABLE: the negative errno, or the string `present`. A raw
 *  `lstat` record cannot be compared here — `mtimeNs` is a BigInt and `JSON.stringify` refuses one —
 *  and what these clauses ask is whether the thing is there, not what its stamp is. */
const stateOf = (fs, path) => {
  const st = fs.lstat(path);
  return typeof st === "number" ? st : "present";
};

/* ---- the fake filesystem ------------------------------------------------------------------- */

const DIR_MODE = S_IFDIR | 0o755;
const FILE_MODE = S_IFREG | 0o644;

/** A path with no trailing slash and no double slashes. `/` stays `/`. */
const norm = (p) => {
  const one = String(p).replace(/\/+/g, "/");
  return one.length > 1 ? one.replace(/\/$/, "") : one;
};
const parentOf = (p) => {
  const at = norm(p).lastIndexOf("/");
  return at <= 0 ? "/" : norm(p).slice(0, at);
};
const nameOf = (p) => norm(p).slice(norm(p).lastIndexOf("/") + 1);

class FakeFs {
  /** `readOnly` is a list of path PREFIXES that answer EROFS to every mutating call — the
   *  read-only provider mounts `/usr` stands for, which D40 left reachable and which every verb
   *  must refuse by name on. */
  constructor(readOnly = []) {
    this.nodes = new Map([["/", { type: "dir", mode: DIR_MODE, mtimeNs: 1000000n }]]);
    this.readOnly = readOnly.map(norm);
    this.fds = new Map();
    this.nextFd = 3;
    this.clock = 1n;
  }

  frozen(path) {
    const p = norm(path);
    return this.readOnly.some((ro) => p === ro || p.startsWith(`${ro}/`));
  }

  stamp() {
    this.clock += 1n;
    return 1700000000000n * 1000000n + this.clock;
  }

  seedDir(path) {
    const p = norm(path);
    const parts = p.split("/").filter((s) => s !== "");
    let at = "";
    for (const part of parts) {
      at = `${at}/${part}`;
      if (!this.nodes.has(at)) {
        this.nodes.set(at, { type: "dir", mode: DIR_MODE, mtimeNs: this.stamp() });
      }
    }
    return p;
  }

  seedFile(path, text, mode = FILE_MODE) {
    const p = norm(path);
    this.seedDir(parentOf(p));
    this.nodes.set(p, {
      type: "file", mode, bytes: std.bytes(text), mtimeNs: this.stamp(),
    });
    return p;
  }

  childrenOf(path) {
    const p = norm(path);
    const prefix = p === "/" ? "/" : `${p}/`;
    const out = [];
    for (const key of this.nodes.keys()) {
      if (key === p || !key.startsWith(prefix)) continue;
      if (key.slice(prefix.length).includes("/")) continue;
      out.push(key);
    }
    return out.sort();
  }

  /* The calls `src/bin/files.mjs` and `src/libos/std.mjs` actually make. */

  lstat(path) {
    const n = this.nodes.get(norm(path));
    if (!n) return -E.ENOENT;
    return {
      mode: n.mode,
      size: n.type === "file" ? n.bytes.length : 64,
      mtimeNs: n.mtimeNs,
    };
  }

  stat(path) { return this.lstat(path); }

  mkdir(path) {
    const p = norm(path);
    if (this.frozen(p)) return -E.EROFS;
    if (this.nodes.has(p)) return -E.EEXIST;
    if (!this.nodes.has(parentOf(p))) return -E.ENOENT;
    this.nodes.set(p, { type: "dir", mode: DIR_MODE, mtimeNs: this.stamp() });
    return 0;
  }

  rmdir(path) {
    const p = norm(path);
    if (this.frozen(p)) return -E.EROFS;
    const n = this.nodes.get(p);
    if (!n) return -E.ENOENT;
    if (n.type !== "dir") return -E.ENOTDIR;
    if (this.childrenOf(p).length > 0) return -E.ENOTEMPTY;
    this.nodes.delete(p);
    return 0;
  }

  unlink(path) {
    const p = norm(path);
    if (this.frozen(p)) return -E.EROFS;
    const n = this.nodes.get(p);
    if (!n) return -E.ENOENT;
    if (n.type === "dir") return -E.EISDIR;
    this.nodes.delete(p);
    return 0;
  }

  /** CLOBBERS AN OCCUPIED DESTINATION, which is `rename(2)`'s contract and `src/fs/vfs.mjs`'s
   *  behaviour. A fake that refused here would make the program's own pre-check untestable. */
  rename(from, to) {
    const a = norm(from);
    const b = norm(to);
    if (this.frozen(a) || this.frozen(b)) return -E.EROFS;
    const n = this.nodes.get(a);
    if (!n) return -E.ENOENT;
    if (!this.nodes.has(parentOf(b))) return -E.ENOENT;
    // A directory moves with its whole subtree, like the real one.
    const moved = [[a, n]];
    if (n.type === "dir") {
      for (const [key, node] of this.nodes) {
        if (key.startsWith(`${a}/`)) moved.push([key, node]);
      }
    }
    for (const [key] of moved) this.nodes.delete(key);
    for (const [key, node] of moved) this.nodes.set(`${b}${key.slice(a.length)}`, node);
    return 0;
  }

  open(path, flags, mode = FILE_MODE & 0o777) {
    const p = norm(path);
    const writing = (flags & O_ACCMODE) !== O_RDONLY;
    if (writing && this.frozen(p)) return -E.EROFS;
    let n = this.nodes.get(p);
    if (!n && (flags & O_CREAT)) {
      if (!this.nodes.has(parentOf(p))) return -E.ENOENT;
      n = { type: "file", mode: S_IFREG | (mode & 0o777), bytes: new Uint8Array(0),
        mtimeNs: this.stamp() };
      this.nodes.set(p, n);
    } else if (!n) {
      return -E.ENOENT;
    } else if ((flags & O_CREAT) && (flags & O_EXCL)) {
      // THE REFUSAL THE COPY HALF OF PASTE RELIES ON, answered by the kernel and not by a test in
      // the program: there is no window between a check and a create.
      return -E.EEXIST;
    } else if (flags & O_TRUNC) {
      n.bytes = new Uint8Array(0);
    }
    if ((flags & O_DIRECTORY) && n.type !== "dir") return -E.ENOTDIR;
    if (!(flags & O_DIRECTORY) && n.type === "dir") return -E.EISDIR;
    const fd = this.nextFd;
    this.nextFd += 1;
    this.fds.set(fd, { path: p, node: n, at: 0 });
    return fd;
  }

  close(fd) {
    return this.fds.delete(fd) ? 0 : -E.EBADF;
  }

  read(fd, into, at = 0, want = into.length - at) {
    const h = this.fds.get(fd);
    if (!h) return -E.EBADF;
    if (h.node.type === "dir") return -E.EISDIR;
    const n = Math.max(0, Math.min(want, h.node.bytes.length - h.at));
    into.set(h.node.bytes.subarray(h.at, h.at + n), at);
    h.at += n;
    return n;
  }

  write(fd, buf) {
    const h = this.fds.get(fd);
    if (!h) return -E.EBADF;
    if (this.frozen(h.path)) return -E.EROFS;
    const next = new Uint8Array(h.at + buf.length);
    next.set(h.node.bytes.subarray(0, h.at), 0);
    next.set(buf, h.at);
    h.node.bytes = next;
    h.at += buf.length;
    h.node.mtimeNs = this.stamp();
    return buf.length;
  }

  readdir(fd, cookie = 0) {
    const h = this.fds.get(fd);
    if (!h) return -E.EBADF;
    if (h.node.type !== "dir") return -E.ENOTDIR;
    const kids = this.childrenOf(h.path);
    if (cookie >= kids.length) return { entries: [], cookie, done: true };
    const entries = kids.slice(cookie).map((key) => ({
      name: nameOf(key),
      type: this.nodes.get(key).type === "dir" ? 4 : 8,
      ino: 0,
    }));
    return { entries, cookie: kids.length, done: false };
  }

  /** The bytes at a path, as a string, for an assertion OUTSIDE the program. Reading the file the
   *  program wrote is the only thing that can say a paste produced equal bytes. */
  textAt(path) {
    const n = this.nodes.get(norm(path));
    return n && n.type === "file" ? std.text(n.bytes) : null;
  }
}

/* ---- the fake clipboard, with the kernel's own lifetimes ----------------------------------- */

class FakeData {
  constructor() {
    this.objects = new Map();
    this.nextFd = 100;
    this.clipboard = null;
    this.creates = 0;
  }

  create(formats) {
    this.creates += 1;
    let mask = 0;
    for (const f of formats) mask |= fmtBit(f);
    const fd = this.nextFd;
    this.nextFd += 1;
    this.objects.set(fd, { offer: mask, payload: new Map(), sealed: false });
    return { fd, offer: mask };
  }

  set(fd, format, bytes) {
    const o = this.objects.get(fd);
    if (!o) return -E.EBADF;
    // SEALED BY PUBLICATION (constraint 242). A Cut that tried to record its intent by rewriting
    // what it had already put on the clipboard would be refused HERE.
    if (o.sealed) return -E.EPERM;
    if (!(o.offer & fmtBit(format))) return -E.ENOTSUP;
    o.payload.set(format, new Uint8Array(bytes));
    return 0;
  }

  get(fd, format) {
    const o = this.objects.get(fd);
    if (!o) return -E.EBADF;
    const got = o.payload.get(format);
    return got ? new Uint8Array(got) : -E.ENOTSUP;
  }

  toClipboard(fd) {
    const o = this.objects.get(fd);
    if (!o) return -E.EBADF;
    o.sealed = true;
    // THE OBJECT OUTLIVES THE FD, which is the whole of "copy, close the window, paste"
    // (constraint 241) — so the slot holds the object and not the descriptor.
    this.clipboard = o;
    return 0;
  }

  open(where) {
    if (where !== DOBJ_WHERE_CLIPBOARD) return -E.EINVAL;
    if (!this.clipboard) return -E.ENOENT;
    const fd = this.nextFd;
    this.nextFd += 1;
    this.objects.set(fd, this.clipboard);
    return { fd, offer: this.clipboard.offer };
  }

  drag() { return -E.EPERM; }

  /** The clipboard's path list as strings, read from OUTSIDE the program. */
  paths() {
    if (!this.clipboard) return null;
    const got = this.clipboard.payload.get(DOBJ_PATHS);
    return got ? std.text(got).split("\0") : null;
  }
}

/* ---- the fake window, and the scripted event stream ---------------------------------------- */

class FakeWin {
  /** `script` is a list of event BATCHES, delivered one per poll. A `q` key is appended, because a
   *  program whose queue runs dry spins in `poll` for its whole 300 s ceiling — a fixture that
   *  could not end would make a failure look like a hang. */
  constructor(script, { menuErrno = 0 } = {}) {
    this.script = [...script, [keyEvent("q")]];
    this.menus = [];
    this.draws = [];
    this.titles = [];
    this.menuErrno = menuErrno;
    this.surfaces = [];
  }

  create() { return { win: 7, fd: 3 }; }
  destroy() { return [7]; }
  setTitle(fd, t) { this.titles.push(String(t)); return 0; }
  surface(fd, w, h) { this.surfaces.push({ w, h }); return 0; }
  draw(fd, ops) { this.draws.push(ops); return 0; }

  menu(fd, x, y, items) {
    this.menus.push({ fd, x, y, items: items.map((r) => ({ ...r })) });
    if (this.menuErrno) return -this.menuErrno;
    return items.length;
  }

  read() {
    return this.script.length > 0 ? this.script.shift() : [];
  }

  pending() { return this.script.length > 0; }
}

const keyEvent = (ch) => {
  const packed = packKeyBytes(std.bytes(ch));
  return { type: WEV_KEY, mods: 0, a: packed.a, b: packed.b, c: 0 };
};
const byteEvent = (code) => {
  const packed = packKeyBytes(new Uint8Array([code]));
  return { type: WEV_KEY, mods: 0, a: packed.a, b: packed.b, c: 0 };
};
const keysymEvent = (sym, mods = 0) => ({ type: WEV_KEY, mods, a: 0, b: 0, c: sym });
const pressEvent = (xCss, yCss, buttons = 1, mods = 0) => ({
  type: WEV_POINTER, mods: WPTR_DOWN | mods, a: Math.round(xCss), b: Math.round(yCss), c: buttons,
});
const releaseEvent = (xCss, yCss) => ({
  type: WEV_POINTER, mods: WPTR_UP, a: Math.round(xCss), b: Math.round(yCss), c: 0,
});
const itemEvent = (index, flags = 0) => ({
  type: WEV_ITEM, mods: 0, a: index, b: flags, c: WITEM_CONTEXT,
});

/** Run `files` with a scripted event stream. `S` is 1 for the whole run — no `WEV_CLIENT` is
 *  delivered — so a CSS pixel and a surface pixel are the same number and a press can be aimed with
 *  `FILES_METRICS.rowMid` directly. The dpr case is the browser page's, where a real ratio exists. */
function drive(fs, data, argv, script, opts = {}) {
  const out = [];
  const win = new FakeWin(script, opts);
  const env = {
    argv: ["files", ...argv],
    fs,
    data,
    win,
    proc: { spawn: () => 42, nanosleep: () => 0 },
    tty: {
      poll: () => ({ fds: [{ revents: win.pending() ? POLLIN : POLLIN }] }),
    },
    std,
    write: (fd, bytes) => { out.push(std.text(bytes)); return bytes.length; },
  };
  const account = runFiles(env);
  return { account, win, stdout: out.join("") };
}

const HOME = "/Users/Default";

/** A fresh tree per section, because a verb that ran in the section above is state this one did not
 *  ask for. Three files and a folder: enough for a range, a sort and a non-empty rmdir. */
const freshFs = (readOnly = []) => {
  const fs = new FakeFs(readOnly);
  fs.seedDir(HOME);
  fs.seedFile(`${HOME}/a.txt`, "alpha");
  fs.seedFile(`${HOME}/b.txt`, "bravo");
  fs.seedDir(`${HOME}/sub`);
  fs.seedFile(`${HOME}/sub/deep.txt`, "deep");
  return fs;
};

/** Where row `i` is, in the unit a press carries at `S === 1`. */
const rowY = (i) => FILES_METRICS.rowMid(i);

/**
 * EVERY TEXT RUN IN THE LAST FRAME THE PROGRAM DREW, decoded with the ABI's OWN codec.
 *
 * `textOfOps` takes ONE index and the records it heads, so the walk is here — and it is the same
 * walk the renderer makes (`src/wm/surface.mjs`), which is the point of reading the display list
 * rather than agreeing a string with the program: what a reader would see is what these ops say.
 */
const runsOf = (run) => {
  const ops = run.win.draws[run.win.draws.length - 1] || [];
  const out = [];
  for (let i = 0; i < ops.length;) {
    const got = ops[i].op === DL_TEXT ? textOfOps(ops, i) : null;
    if (!got) { i += 1; continue; }
    out.push(got.text);
    i += got.records;
  }
  return out;
};
const nameAt = (account, i) => (account.rows[i] ? account.rows[i].name : null);
const rowIndexOf = (account, name) => account.rows.findIndex((r) => r.name === name);

/**
 * THE PRESS POINT FOR THE ROW NAMED `name`, LEARNED FROM THE PROGRAM'S OWN LISTING.
 *
 * NOT AN INDEX THIS FILE PICKED. Seeding one more directory changes the order — directories sort
 * first — so a hard-coded `rowMid(1)` aims at a different file in a tree with a `into/` in it than
 * in one without, and the first draft of this probe copied `sub` while every clause said `a.txt`.
 * That is the WRONG FILE DRAGGED defect `FILES_METRICS` exists to stop, arriving in the driver
 * rather than in the program.
 */
const rowYOf = (fs, dirPath, name) => {
  const probe = drive(fs, new FakeData(), dirPath ? [dirPath] : [], []);
  const i = rowIndexOf(probe.account, name);
  if (i < 0) throw new Error(`rowYOf: ${dirPath || HOME} has no row named ${name}`);
  return FILES_METRICS.rowMid(i);
};

/* ---- 1. NEW FOLDER: it appears in a fresh readdir ------------------------------------------ */
{
  const fs = freshFs();
  const data = new FakeData();
  // Ctrl+N, then a second one: the SECOND is what proves the numbering, because `New folder` is
  // taken by then and a program that did not look would be refused EEXIST.
  const { account } = drive(fs, data, [], [[byteEvent(14)], [byteEvent(14)]]);
  check("new folder: two were created", account.created, ["New folder", "New folder (2)"]);
  checkThat("new folder: the first is a DIRECTORY in the fake filesystem",
    (fs.lstat(`${HOME}/New folder`).mode & S_IFMT) === S_IFDIR,
    `mode ${(fs.lstat(`${HOME}/New folder`) || {}).mode}`);
  checkThat("new folder: the second one too",
    (fs.lstat(`${HOME}/New folder (2)`).mode & S_IFMT) === S_IFDIR, null);
  // THE PROGRAM'S OWN FRESH `readdir` IS THE OTHER READING, and the two must agree: the row list
  // came back out of the filesystem rather than being patched in place.
  checkThat("new folder: it is a row in the program's own re-listing",
    rowIndexOf(account, "New folder (2)") >= 0, account.rows.map((r) => r.name));
  check("new folder: and it is SELECTED after the second one",
    account.selected.map((i) => nameAt(account, i)), ["New folder (2)"]);
  check("new folder: nothing was refused", account.refusals, []);
}

/* ---- 2. F2 RENAME: the bytes move with the name -------------------------------------------- */
{
  const fs = freshFs();
  const data = new FakeData();
  const script = [
    [pressEvent(60, rowY(1)), releaseEvent(60, rowY(1))],
    [keysymEvent(WKEY_F2)],
    // The draft opens holding `a.txt`; six Backspaces clear it and `z.md` is typed.
    [byteEvent(127), byteEvent(127), byteEvent(127), byteEvent(127), byteEvent(127)],
    [...std.bytes("z.md")].map((b) => byteEvent(b)),
    [byteEvent(10)],
  ];
  const first = drive(fs, data, [], []).account;
  check("rename: row 1 is the file the press lands on", nameAt(first, 1), "a.txt");
  const { account } = drive(fs, data, [], script);
  check("rename: the program reports the move", account.renamed, [{ from: "a.txt", to: "z.md" }]);
  check("rename: the BYTES are at the new name", fs.textAt(`${HOME}/z.md`), "alpha");
  check("rename: and nothing is at the old one", fs.textAt(`${HOME}/a.txt`), null);
  checkThat("rename: the new name is a row and the old one is not",
    rowIndexOf(account, "z.md") >= 0 && rowIndexOf(account, "a.txt") < 0,
    account.rows.map((r) => r.name));
  check("rename: the field is closed afterwards", account.renaming, null);
}

/* ---- 3. RENAME REFUSES BY NAME, AND EACH REFUSAL CARRIES ITS OWN ERRNO --------------------- */
{
  const fs = freshFs();
  const data = new FakeData();
  // `a.txt` renamed onto `b.txt`, which is occupied: `rename(2)` would REPLACE it, so the refusal
  // is the program's and EEXIST is the errno it owes.
  const script = [
    [pressEvent(60, rowY(1)), releaseEvent(60, rowY(1))],
    [keysymEvent(WKEY_F2)],
    [byteEvent(127), byteEvent(127), byteEvent(127), byteEvent(127), byteEvent(127)],
    [...std.bytes("b.txt")].map((b) => byteEvent(b)),
    [byteEvent(10)],
  ];
  const { account } = drive(fs, data, [], script);
  check("rename onto an occupied name: refused by name, with EEXIST",
    account.refusals.map((r) => [r.what, r.errno]), [["b.txt", "EEXIST"]]);
  check("rename onto an occupied name: the occupant's bytes are untouched",
    fs.textAt(`${HOME}/b.txt`), "bravo");
  check("rename onto an occupied name: and the source is still there",
    fs.textAt(`${HOME}/a.txt`), "alpha");
  check("rename onto an occupied name: nothing was renamed", account.renames, 0);
}
{
  const fs = freshFs();
  const data = new FakeData();
  const script = [
    [pressEvent(60, rowY(1)), releaseEvent(60, rowY(1))],
    [keysymEvent(WKEY_F2)],
    [byteEvent(127), byteEvent(127), byteEvent(127), byteEvent(127), byteEvent(127)],
    [...std.bytes("x/y")].map((b) => byteEvent(b)),
    [byteEvent(10)],
  ];
  const { account } = drive(fs, data, [], script);
  // A SLASH IS THE PROGRAM'S OWN REFUSAL AND CARRIES NO ERRNO, which is the distinction `refuse`'s
  // third argument makes: a clause asserting "it refused with an errno" must not pass for this.
  check("rename to a path: refused by name, with NO errno",
    account.refusals.map((r) => [r.what, r.errno === undefined]), [["x/y", true]]);
  check("rename to a path: and the file did not move", fs.textAt(`${HOME}/a.txt`), "alpha");
}
{
  const fs = freshFs();
  const data = new FakeData();
  const script = [
    [pressEvent(60, rowY(1)), releaseEvent(60, rowY(1))],
    [keysymEvent(WKEY_F2)],
    [byteEvent(27)],
    [byteEvent(10)],
  ];
  const { account } = drive(fs, data, [], script);
  check("Esc abandons the edit", account.renaming, null);
  check("Esc renames nothing", account.renames, 0);
  check("Esc is not a refusal", account.refusals, []);
  check("and the Enter after it falls through to ACTIVATE the cursor's row",
    account.spawned.length, 1);
}

/* ---- 4. DELETE: gone from the filesystem; a non-empty folder refused ENOTEMPTY ------------- */
{
  const fs = freshFs();
  const data = new FakeData();
  const { account } = drive(fs, data, [], [
    [pressEvent(60, rowY(1)), releaseEvent(60, rowY(1))],
    [keysymEvent(WKEY_DELETE)],
  ]);
  check("delete: the program names what went", account.deleted, ["a.txt"]);
  check("delete: and it is gone from the filesystem", stateOf(fs, `${HOME}/a.txt`), -E.ENOENT);
  check("delete: the other file is untouched", fs.textAt(`${HOME}/b.txt`), "bravo");
  check("delete: and the row is gone from a fresh listing", rowIndexOf(account, "a.txt"), -1);
}
{
  const fs = freshFs();
  const data = new FakeData();
  // Row 0 is `sub`, the non-empty directory: directories sort first.
  const { account } = drive(fs, data, [], [
    [pressEvent(60, rowY(0)), releaseEvent(60, rowY(0))],
    [keysymEvent(WKEY_DELETE)],
  ]);
  check("delete: row 0 is the directory", nameAt(account, 0), "sub");
  check("delete a non-empty folder: refused by name, with ENOTEMPTY",
    account.refusals.map((r) => [r.what, r.errno]), [["sub", "ENOTEMPTY"]]);
  check("delete a non-empty folder: and its contents are still there",
    fs.textAt(`${HOME}/sub/deep.txt`), "deep");
  check("delete a non-empty folder: nothing was deleted", account.deleted, []);
}

/* ---- 5. COPY AND PASTE: equal bytes, and the ONE clipboard --------------------------------- */
{
  const fs = freshFs();
  fs.seedDir(`${HOME}/into`);
  /* THE DESTINATION IS NOT EMPTY, and it has to not be: `files <an empty directory>` on the COMMAND
   * LINE exits at once with "this directory is empty", because there is no window to say it in
   * (`src/bin/files.mjs`). An empty one navigated INTO keeps the window, which is section 6. */
  fs.seedFile(`${HOME}/into/keep.txt`, "keep");
  const data = new FakeData();
  const y = rowYOf(fs, null, "a.txt");
  const copy = drive(fs, data, [], [
    [pressEvent(60, y), releaseEvent(60, y)],
    [byteEvent(3)],
  ]);
  check("copy: the program says what it published",
    copy.account.clipboard, { intent: "copy", paths: [`${HOME}/a.txt`] });
  check("copy: and the KERNEL'S clipboard holds that path list", data.paths(),
    [`${HOME}/a.txt`]);
  check("copy: as DOBJ_PATHS and nothing else", fmtsOf(data.clipboard.offer), [DOBJ_PATHS]);
  // A SECOND PROCESS pastes it, which is the whole point of the slot being the kernel's: the
  // copying program has already exited.
  const paste = drive(fs, data, [`${HOME}/into`], [[byteEvent(22)]]);
  check("paste: one file landed", paste.account.pasted, [{ name: "a.txt", moved: false }]);
  check("paste: the BYTES are equal", fs.textAt(`${HOME}/into/a.txt`), "alpha");
  check("paste: the original is still there", fs.textAt(`${HOME}/a.txt`), "alpha");
  checkThat("paste: and it is a row in the pasting window's own re-listing",
    rowIndexOf(paste.account, "a.txt") >= 0, paste.account.rows.map((r) => r.name));
}

/* ---- 6. CUT AND PASTE IS A MOVE, AND THE SOURCE IS GONE ----------------------------------- */
{
  const fs = freshFs();
  fs.seedDir(`${HOME}/into`);
  const data = new FakeData();
  const y = rowYOf(fs, null, "a.txt");
  /* ONE PROCESS, TWO DIRECTORIES, AND THE CUT CROSSES A RE-LIST. The intent is this program's own
   * state (the published object is sealed and carries no field for it), so the paste has to happen
   * in the SAME process — and `into` is navigated into by a double-click, which is the route a
   * reader takes. A second process pasting the same list would be a COPY, which is section 5. */
  const intoY = rowYOf(fs, null, "into");
  const { account } = drive(fs, data, [], [
    [pressEvent(60, y), releaseEvent(60, y)],
    [byteEvent(24)],
    [pressEvent(60, intoY, 1, WPTR_CLICK2), releaseEvent(60, intoY)],
    [byteEvent(22)],
  ]);
  check("cut: the kernel's clipboard holds the path", data.paths(), [`${HOME}/a.txt`]);
  check("cut: the window followed the double-click into the destination", account.dir,
    `${HOME}/into`);
  check("cut+paste: it landed as a MOVE", account.pasted, [{ name: "a.txt", moved: true }]);
  check("cut+paste: the bytes are at the destination", fs.textAt(`${HOME}/into/a.txt`), "alpha");
  check("cut+paste: and the SOURCE is gone", stateOf(fs, `${HOME}/a.txt`), -E.ENOENT);
  check("cut+paste: a move spends the cut", account.clipboard, null);
}

/* ---- 7. PASTE ONTO AN OCCUPIED NAME IS REFUSED, AND `--paste-clobbers` IS THAT WORLD ------- */
{
  const fs = freshFs();
  fs.seedDir(`${HOME}/into`);
  fs.seedFile(`${HOME}/into/a.txt`, "ALREADY HERE");
  const data = new FakeData();
  const y = rowYOf(fs, null, "a.txt");
  drive(fs, data, [], [
    [pressEvent(60, y), releaseEvent(60, y)],
    [byteEvent(3)],
  ]);
  const refused = drive(fs, data, [`${HOME}/into`], [[byteEvent(22)]]);
  check("paste onto an occupied name: refused by name, with EEXIST",
    refused.account.refusals.map((r) => [r.what, r.errno]), [["a.txt", "EEXIST"]]);
  check("paste onto an occupied name: the occupant's bytes SURVIVE",
    fs.textAt(`${HOME}/into/a.txt`), "ALREADY HERE");
  check("paste onto an occupied name: nothing landed", refused.account.pasted, []);

  const clobber = drive(fs, data, [`${HOME}/into`, "--paste-clobbers"], [[byteEvent(22)]]);
  check("--paste-clobbers: it lands instead", clobber.account.pasted,
    [{ name: "a.txt", moved: false }]);
  check("--paste-clobbers: AND THE READER'S FILE IS DESTROYED, which is the control",
    fs.textAt(`${HOME}/into/a.txt`), "alpha");
  check("--paste-clobbers: with no refusal anywhere", clobber.account.refusals, []);
}

/* ---- 8. A DIRECTORY IS MOVED AND NOT COPIED ------------------------------------------------ */
{
  const fs = freshFs();
  fs.seedDir(`${HOME}/into`);
  fs.seedFile(`${HOME}/into/keep.txt`, "keep");
  const data = new FakeData();
  const y = rowYOf(fs, null, "sub");
  drive(fs, data, [], [
    [pressEvent(60, y), releaseEvent(60, y)],
    [byteEvent(3)],
  ]);
  const { account } = drive(fs, data, [`${HOME}/into`], [[byteEvent(22)]]);
  check("copying a directory: refused by name", account.refusals.map((r) => r.what), ["sub"]);
  check("copying a directory: with NO errno, because it is this program's own refusal",
    account.refusals.map((r) => r.errno === undefined), [true]);
  check("copying a directory: nothing was created", stateOf(fs, `${HOME}/into/sub`), -E.ENOENT);
}

/* ---- 9. THE READ-ONLY EDGE: EVERY VERB REFUSES BY NAME, WITH EROFS ------------------------- */
{
  const BASE = "/usr/share";
  const mk = () => {
    const fs = new FakeFs(["/usr"]);
    fs.seedDir(BASE);
    fs.seedFile(`${BASE}/note.txt`, "frozen");
    fs.seedFile(`${BASE}/other.txt`, "also frozen");
    return fs;
  };
  const press0 = [pressEvent(60, rowY(0)), releaseEvent(60, rowY(0))];

  const made = drive(mk(), new FakeData(), [BASE], [[byteEvent(14)]]);
  check("read-only: New folder refuses with EROFS",
    made.account.refusals.map((r) => [r.what, r.errno]), [["New folder", "EROFS"]]);
  check("read-only: and nothing was created", made.account.created, []);

  const del = drive(mk(), new FakeData(), [BASE], [press0, [keysymEvent(WKEY_DELETE)]]);
  check("read-only: Delete refuses with EROFS",
    del.account.refusals.map((r) => [r.what, r.errno]), [["note.txt", "EROFS"]]);
  check("read-only: and nothing was deleted", del.account.deleted, []);

  const renameScript = [
    press0,
    [keysymEvent(WKEY_F2)],
    [...std.bytes("x")].map((b) => byteEvent(b)),
    [byteEvent(10)],
  ];
  const ren = drive(mk(), new FakeData(), [BASE], renameScript);
  check("read-only: rename refuses with EROFS",
    ren.account.refusals.map((r) => [r.what, r.errno]), [["note.txt", "EROFS"]]);
  check("read-only: and nothing was renamed", ren.account.renames, 0);

  // COPY IS NOT REFUSED THERE, and that is correct rather than an omission: reading a frozen file
  // and putting its path on the clipboard mutates nothing. The PASTE is where EROFS arrives.
  const roFs = mk();
  const roData = new FakeData();
  const copied = drive(roFs, roData, [BASE], [press0, [byteEvent(3)]]);
  check("read-only: Copy is allowed, because it writes nothing",
    copied.account.refusals, []);
  check("read-only: and the clipboard holds the frozen path", roData.paths(),
    [`${BASE}/note.txt`]);
  /* PASTING INTO THE READ-ONLY MOUNT, and the source has to come from OUTSIDE it: a path already in
   * this directory is refused for being there and never reaches the destination at all, which is a
   * different clause. So a writable `/tmp` is seeded, copied from, and pasted here — the
   * destination is what refuses and EROFS is the kernel's own answer to `open(O_CREAT)`. */
  const crossFs = mk();
  crossFs.seedFile("/tmp/bring.txt", "from outside");
  const crossData = new FakeData();
  const tmpY = rowYOf(crossFs, "/tmp", "bring.txt");
  drive(crossFs, crossData, ["/tmp"], [
    [pressEvent(60, tmpY), releaseEvent(60, tmpY)],
    [byteEvent(3)],
  ]);
  const intoRo = drive(crossFs, crossData, [BASE], [[byteEvent(22)]]);
  check("read-only: Paste into it refuses by name, with EROFS",
    intoRo.account.refusals.map((r) => [r.what, r.errno]), [["bring.txt", "EROFS"]]);
  check("read-only: and nothing landed there", stateOf(crossFs, `${BASE}/bring.txt`), -E.ENOENT);
}

/* ---- 10. THE TWO MENUS, AS A `win_menu` CALL ---------------------------------------------- */
{
  const fs = freshFs();
  const data = new FakeData();
  const onRow = drive(fs, data, [], [[pressEvent(60, rowY(1), 2)]]);
  check("a right press raises exactly one menu", onRow.win.menus.length, 1);
  check("and the program counts it", onRow.account.menus, 1);
  check("the ROW menu's labels",
    onRow.win.menus[0].items.map((r) => r.label),
    ["Open", "", "Cut", "Copy", "", "Delete", "Rename"]);
  check("every row carries WITEM_CONTEXT",
    onRow.win.menus[0].items.every((r) => (r.flags & WITEM_CONTEXT) !== 0), true);
  check("the two rules are separators",
    onRow.win.menus[0].items.filter((r) => r.flags & WITEM_SEPARATOR).length, 2);
  check("the menu is aimed at the point the press carried, in SURFACE px",
    [onRow.win.menus[0].x, onRow.win.menus[0].y], [60, Math.round(rowY(1))]);
  check("and the right press SELECTED the row it was on",
    onRow.account.selected.map((i) => nameAt(onRow.account, i)), ["a.txt"]);
  check("a right press arms no drag", onRow.account.drags, 0);

  /* EMPTY SPACE IS THE GAP BETWEEN TWO ROWS, and it has to be: the window opens at exactly the
   * height of its rows (`clientHeightFor`), so there is no blank paper under the last one until a
   * reader resizes or deletes something. The gap is the case `inViewport` and `rowUnder` were split
   * into two functions for — inside the viewport, on no row — so it is the right point rather than
   * a convenient one. */
  const emptyY = FILES_METRICS.rowTop(0) + FILES_METRICS.ROW_H + 1;
  const onEmpty = drive(freshFs(), new FakeData(), [], [[pressEvent(60, emptyY, 2)]]);
  check("empty space raises the OTHER menu",
    onEmpty.win.menus[0].items.map((r) => r.label), ["New folder", "", "Paste"]);
  check("Paste is DISABLED with an empty clipboard",
    (onEmpty.win.menus[0].items[2].flags & WITEM_DISABLED) !== 0, true);
  check("and the program reports which row it was raised on", onEmpty.account.menuTarget, -1);

  const withClip = new FakeData();
  drive(fs, withClip, [], [[pressEvent(60, rowY(1)), releaseEvent(60, rowY(1))], [byteEvent(3)]]);
  const live = drive(freshFs(), withClip, [], [[pressEvent(60, emptyY, 2)]]);
  check("Paste is LIVE once the clipboard holds a path list",
    (live.win.menus[0].items[2].flags & WITEM_DISABLED) !== 0, false);
}

/* ---- 11. A PICK RUNS THE VERB, AND A DISMISSAL IS REPORTED --------------------------------- */
{
  const fs = freshFs();
  const data = new FakeData();
  // Row 5 of the row menu is Delete. The kernel would send the index; this sends it directly,
  // which is the same record the page's `activateItem` produces.
  const { account } = drive(fs, data, [], [
    [pressEvent(60, rowY(1), 2)],
    [itemEvent(5)],
  ]);
  check("the picked row's verb ran", account.chosen, ["delete"]);
  check("and the file is gone from the filesystem", stateOf(fs, `${HOME}/a.txt`), -E.ENOENT);
  check("the open menu is forgotten afterwards", account.menuRows, []);
}
{
  const fs = freshFs();
  const { account } = drive(fs, new FakeData(), [], [
    [pressEvent(60, rowY(1), 2)],
    [itemEvent(-1)],
  ]);
  check("a dismissal is counted", account.dismissals, 1);
  check("a dismissal chooses nothing", account.chosen, []);
  check("a dismissal is not a refusal", account.refusals, []);
  check("and the filesystem is untouched", fs.textAt(`${HOME}/a.txt`), "alpha");
}
{
  // A SEPARATOR'S INDEX. The kernel refuses this and never sends it, so what is asserted here is
  // the program's own second line of defence: `runVerb` has no verb for it and says so.
  const { account } = drive(freshFs(), new FakeData(), [], [
    [pressEvent(60, rowY(1), 2)],
    [itemEvent(1, WITEM_SEPARATOR)],
  ]);
  check("a separator's index is refused by name",
    account.refusals.map((r) => r.what), ["a separator"]);
}
{
  // An index past the menu's rows: refused by name rather than acted on.
  const { account } = drive(freshFs(), new FakeData(), [], [
    [pressEvent(60, rowY(1), 2)],
    [itemEvent(99)],
  ]);
  check("an index the menu does not have is refused by name",
    account.refusals.map((r) => r.what), ["menu row 99"]);
}
{
  // A `WEV_ITEM` with no `WITEM_CONTEXT` indexes a list this program never published.
  const { account } = drive(freshFs(), new FakeData(), [], [
    [{ type: WEV_ITEM, mods: 0, a: 0, b: 0, c: 0 }],
  ]);
  check("an item from somewhere other than a context menu is refused",
    account.refusals.map((r) => r.what), ["item 0"]);
}

/* ---- 12. `win_menu` REFUSED: SAID BY NAME AND COUNTED ------------------------------------- */
{
  const { account, win } = drive(freshFs(), new FakeData(), [], [[pressEvent(60, rowY(1), 2)]],
    { menuErrno: E.EHOSTGONE });
  check("the call was made", win.menus.length, 1);
  check("a refused raise is counted apart from a successful one",
    [account.menus, account.refusedMenus], [0, 1]);
  check("and said by name, with the kernel's errno",
    account.refusals.map((r) => [r.what, r.errno]), [["a context menu", "EHOSTGONE"]]);
}

/* ---- 13. `--menu-in-surface`: NO `win_menu`, AND THE LABELS ARE IN THE DISPLAY LIST ------- */
{
  const plain = drive(freshFs(), new FakeData(), [], [[pressEvent(60, rowY(1), 2)]]);
  const control = drive(freshFs(), new FakeData(), ["--menu-in-surface"],
    [[pressEvent(60, rowY(1), 2)]]);
  check("--menu-in-surface: no win_menu reaches the kernel", control.win.menus.length, 0);
  check("--menu-in-surface: so none is counted", control.account.menus, 0);
  checkThat("--menu-in-surface: the menu's labels are in the DISPLAY LIST",
    runsOf(control).includes("Rename"), runsOf(control).join("|"));
  checkThat("...and with win_menu they are NOT, because the page draws the popup",
    !runsOf(plain).includes("Rename"), runsOf(plain).join("|"));
  checkThat("--menu-in-surface: the program reports where it drew one",
    control.account.menuInSurfaceAt !== null, String(control.account.menuInSurfaceAt));
}

/* ---- 14. A PRESS CLOSES AN OPEN RENAME AND IS SPENT DOING IT ------------------------------ */
{
  const fs = freshFs();
  const { account } = drive(fs, new FakeData(), [], [
    [pressEvent(60, rowY(1)), releaseEvent(60, rowY(1))],
    [keysymEvent(WKEY_F2)],
    [...std.bytes("zz")].map((b) => byteEvent(b)),
    [pressEvent(60, rowY(2))],
  ]);
  check("a press abandons the edit", account.renaming, null);
  check("and renames nothing", account.renames, 0);
  check("and does NOT also move the selection, because one click is one action",
    account.selected.map((i) => nameAt(account, i)), ["a.txt"]);
  check("the file is untouched", fs.textAt(`${HOME}/a.txt`), "alpha");
}

/* ---- 15. AN OPEN RENAME SWALLOWS THE KEYBOARD -------------------------------------------- */
{
  const fs = freshFs();
  const { account } = drive(fs, new FakeData(), [], [
    [pressEvent(60, rowY(1)), releaseEvent(60, rowY(1))],
    [keysymEvent(WKEY_F2)],
    // A Delete key and a Ctrl+X while the box is open: both must do NOTHING.
    [keysymEvent(WKEY_DELETE), byteEvent(24)],
    [byteEvent(27)],
  ]);
  check("Delete while renaming deletes nothing", account.deleted, []);
  check("Ctrl+X while renaming publishes nothing", account.clipboard, null);
  check("the file is still there", fs.textAt(`${HOME}/a.txt`), "alpha");
}

/* ---- the report ---------------------------------------------------------------------------- */

const scored = results.map((r) => ({ ...r, ok: INVERT ? !r.ok : r.ok }));
const failed = scored.filter((r) => !r.ok);
for (const r of scored) {
  const line = `${r.ok ? "ok  " : "FAIL"}  ${r.name}`;
  if (r.ok) console.log(line);
  else console.log(`${line}\n        got  ${JSON.stringify(r.got ?? r.detail)}`
    + `${r.want === undefined ? "" : `\n        want ${JSON.stringify(r.want)}`}`);
}
console.log(`\n${scored.length - failed.length}/${scored.length} expectations`
  + `${INVERT ? " INVERTED" : ""}`);
if (INVERT) {
  // A PROOF THAT SUCCEEDED EXITS 0, which is `scripts/check.py --prove-failure`'s own convention:
  // non-zero is reserved for a proof that failed to fail.
  const flipped = results.length - results.filter((r) => r.ok).length;
  console.log(`--prove-failure: ${results.length} expectation(s) inverted, `
    + `${flipped} were already failing`);
  process.exit(flipped === 0 ? 0 : 1);
}
process.exit(failed.length === 0 ? 0 : 1);
