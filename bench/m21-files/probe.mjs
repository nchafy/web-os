// M21's THREE PROGRAM PIECES — the Bin, F5 and the drop target — under plain Node.
//
//   node --experimental-loader ./bench/m20-verbs/loader.mjs bench/m21-files/probe.mjs
//   node --experimental-loader ./bench/m20-verbs/loader.mjs bench/m21-files/probe.mjs --prove-failure
//
// THE FILESYSTEM HERE IS THE REAL ONE. `bench/m20-verbs/probe.mjs` drives `files` against a fake
// built out of a path map; this one drives it against `src/fs/vfs.mjs` itself, with a Map of blob
// bytes beside it where `src/kernel/store.mjs` would be. That is not tidiness — it is constraint
// 98's rule applied to the three things this milestone turns on, each of which a fake would have to
// be TRUSTED about and the real thing can be ASKED:
//
//   `rename` CLOBBERS A PLAIN DESTINATION and frees the occupant's inode, in one journal record.
//   That is why a restore pre-checks in userland, and `bench/m21-bin/probe.mjs` measured it
//   (`renameRefused: null`, `freedInode: 8`, `clobbered: true`). A fake that refused on its own
//   would let the pre-check be deleted with every clause still green.
//   `symlink` STORES ITS TARGET VERBATIM in ONE op and applies no `NAME_MAX` to it, which is the
//   whole reason the origin record is a symlink rather than a file of bytes.
//   `rmdir` ANSWERS ENOTEMPTY and `openDecision(create, excl)` answers EEXIST, so the refusals this
//   program reports by name are the filesystem's own words.
//
// WHAT IS STILL A DOUBLE is the window and the clipboard: `FakeWin` plays a scripted batch per
// poll and `FakeData` holds one clipboard slot and one drag session with the kernel's own
// lifetimes. What a reader SEES is not assertable from here — a popup is a DOM node and a drop
// point comes off a real hit test — so this probe asserts the filesystem and the account, and the
// pixels and the gestures belong to the browser-driven page.
//
// `--prove-failure` inverts every expectation, so a run that reports no failures has not been
// checked (CLAUDE.md). It exits 0 when the proof SUCCEEDED.
import { run as runFiles, FILES_METRICS } from "../../src/bin/files.mjs";
import * as std from "../../src/libos/std.mjs";
import { VFS, FsError } from "../../src/fs/vfs.mjs";
import {
  E, S_IFMT, S_IFDIR, S_IFREG, S_IFLNK, O_DIRECTORY, O_CREAT, O_EXCL, O_ACCMODE, O_RDONLY,
  O_TRUNC, POLLIN, WEV_KEY, WEV_POINTER, WEV_ITEM, WEV_DROP, WEV_DRAG_ENTER, WEV_DRAG_DONE,
  WPTR_DOWN, WPTR_UP, WPTR_MOVE, WKEY_F5, WKEY_DELETE, WMOD_CTRL, WITEM_CONTEXT,
  WITEM_DISABLED,
  packKeyBytes, DOBJ_PATHS, DOBJ_TEXT, DOBJ_WHERE_CLIPBOARD, DOBJ_WHERE_DROP,
  DOBJ_EFFECT_COPY, DOBJ_EFFECT_MOVE, fmtBit,
} from "../../src/abi.mjs";

const INVERT = process.argv.includes("--prove-failure");
const results = [];
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  results.push({ name, ok, got: ok ? undefined : got, want: ok ? undefined : want });
};
const checkThat = (name, cond, detail) =>
  results.push({ name, ok: !!cond, detail: cond ? undefined : detail });

/* ---- the real VFS behind an `env.fs` ------------------------------------------------------- */

/** Constraint 29: a credential is an argument on every path call, never instance state. */
const CRED = { uid: 0, gid: 0 };
/** The `type` strings `src/fs/vfs.mjs` uses, named here because `#info` hands them back. */
const T_DIR = "dir";
const T_FILE = "file";
const T_LINK = "link";

/**
 * `env.fs` OVER A REAL `VFS`, with the blob bytes in a Map keyed the way `src/kernel/store.mjs`
 * keys them (`ino.gen`). Every metadata answer is the filesystem's; only the bytes are local.
 *
 * AN `FsError` BECOMES A NEGATIVE ERRNO HERE AND NOWHERE ELSE, which is `src/kernel/calls.mjs`'s
 * own boundary: the VFS throws named codes and the ABI carries numbers.
 */
class RealFs {
  constructor() {
    let t = 1_700_000_000_000;
    this.vfs = new VFS({ now: () => (t += 1000) });
    this.blobs = new Map();
    this.fds = new Map();
    this.nextFd = 3;
  }

  #try(fn) {
    try {
      return fn();
    } catch (e) {
      if (e instanceof FsError) return -(E[e.code] || E.EIO);
      throw e;
    }
  }

  #bytesOf(ino, gen) {
    return this.blobs.get(`${ino}.${gen}`) || new Uint8Array(0);
  }

  seedDir(path) { return this.#try(() => { this.vfs.mkdir(CRED, path); return 0; }); }

  seedFile(path, text, mode = 0o644) {
    const bytes = std.bytes(text);
    const d = this.vfs.openDecision(CRED, path, { create: true, mode });
    this.blobs.set(`${d.ino}.${d.gen + 1}`, bytes);
    this.vfs.commit(d.ino, d.gen + 1, bytes.length);
    return path;
  }

  /** A path's state as something COMPARABLE: the negative errno, or what kind of thing is there.
   *  A raw record cannot be compared — `mtimeNs` is a BigInt and `JSON.stringify` refuses one. */
  kindAt(path) {
    return this.#try(() => this.vfs.lstat(CRED, path).type);
  }

  textAt(path) {
    return this.#try(() => {
      const st = this.vfs.lstat(CRED, path);
      return st.type === T_FILE ? std.text(this.#bytesOf(st.ino, st.gen)) : null;
    });
  }

  namesIn(path) {
    return this.#try(() => this.vfs.readdir(CRED, path).slice().sort());
  }

  linkAt(path) { return this.#try(() => this.vfs.readlink(CRED, path)); }

  /* ---- the calls `src/bin/files.mjs` and `src/libos/std.mjs` make ---- */

  lstat(path) {
    return this.#try(() => {
      const st = this.vfs.lstat(CRED, path);
      const bits = st.type === T_DIR ? S_IFDIR : st.type === T_LINK ? S_IFLNK : S_IFREG;
      return { mode: bits | (st.mode & 0o7777), size: st.size, mtimeNs: BigInt(st.mtime) * 1000000n };
    });
  }

  stat(path) {
    return this.#try(() => {
      const st = this.vfs.stat(CRED, path);
      const bits = st.type === T_DIR ? S_IFDIR : st.type === T_LINK ? S_IFLNK : S_IFREG;
      return { mode: bits | (st.mode & 0o7777), size: st.size, mtimeNs: BigInt(st.mtime) * 1000000n };
    });
  }

  mkdir(path, mode = 0o755) {
    return this.#try(() => { this.vfs.mkdir(CRED, path, { mode }); return 0; });
  }

  rmdir(path) { return this.#try(() => { this.vfs.rmdir(CRED, path); return 0; }); }

  unlink(path) { return this.#try(() => { this.vfs.unlink(CRED, path); return 0; }); }

  rename(from, to) { return this.#try(() => { this.vfs.rename(CRED, from, to); return 0; }); }

  symlink(target, path) {
    return this.#try(() => { this.vfs.symlink(CRED, target, path); return 0; });
  }

  readlink(path) { return this.#try(() => this.vfs.readlink(CRED, path)); }

  open(path, flags, mode = 0o644) {
    return this.#try(() => {
      const writing = (flags & O_ACCMODE) !== O_RDONLY;
      const d = this.vfs.openDecision(CRED, path, {
        create: !!(flags & O_CREAT),
        excl: !!(flags & O_EXCL),
        dirOk: !!(flags & O_DIRECTORY),
        wantR: !writing,
        wantW: writing,
        mode,
      });
      if ((flags & O_DIRECTORY) && d.type !== T_DIR) return -E.ENOTDIR;
      if (!(flags & O_DIRECTORY) && d.type === T_DIR) return -E.EISDIR;
      const fd = this.nextFd;
      this.nextFd += 1;
      const truncating = !!(flags & O_TRUNC) || d.created !== null;
      this.fds.set(fd, {
        ino: d.ino, gen: d.gen, type: d.type, at: 0,
        bytes: truncating ? new Uint8Array(0) : this.#bytesOf(d.ino, d.gen),
        dirty: truncating,
        path,
      });
      return fd;
    });
  }

  close(fd) {
    const h = this.fds.get(fd);
    if (!h) return -E.EBADF;
    this.fds.delete(fd);
    // A COMMIT IS WHAT MAKES A WRITE DURABLE, exactly as the kernel does it: a new generation,
    // then the metadata swung to it (`src/kernel/store.mjs`).
    if (h.dirty) {
      this.blobs.set(`${h.ino}.${h.gen + 1}`, h.bytes);
      this.#try(() => this.vfs.commit(h.ino, h.gen + 1, h.bytes.length));
    }
    return 0;
  }

  read(fd, into, at = 0, want = into.length - at) {
    const h = this.fds.get(fd);
    if (!h) return -E.EBADF;
    if (h.type === T_DIR) return -E.EISDIR;
    const n = Math.max(0, Math.min(want, h.bytes.length - h.at));
    into.set(h.bytes.subarray(h.at, h.at + n), at);
    h.at += n;
    return n;
  }

  write(fd, buf) {
    const h = this.fds.get(fd);
    if (!h) return -E.EBADF;
    const next = new Uint8Array(h.at + buf.length);
    next.set(h.bytes.subarray(0, h.at), 0);
    next.set(buf, h.at);
    h.bytes = next;
    h.at += buf.length;
    h.dirty = true;
    return buf.length;
  }

  readdir(fd, cookie = 0) {
    const h = this.fds.get(fd);
    if (!h) return -E.EBADF;
    if (h.type !== T_DIR) return -E.ENOTDIR;
    const kids = this.#try(() => this.vfs.listIno(h.ino));
    if (typeof kids === "number") return kids;
    if (cookie >= kids.length) return { entries: [], cookie, done: true };
    // THE TYPE IS THE FILESYSTEM'S OWN, which is what makes the Bin's `DT_LNK` filter testable:
    // `src/kernel/calls.mjs`'s `DIRENT_TYPE` is the same mapping.
    const entries = kids.slice(cookie).map((e) => ({
      name: e.name, ino: e.ino,
      type: e.type === T_DIR ? 4 : e.type === T_LINK ? 10 : 8,
    }));
    return { entries, cookie: kids.length, done: false };
  }
}

/* ---- the clipboard and the drag session, with the kernel's lifetimes ----------------------- */

class FakeData {
  constructor() {
    this.objects = new Map();
    this.nextFd = 100;
    this.clipboard = null;
    this.drop = null;
    this.drags = [];
  }

  create(formats) {
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
    this.clipboard = o;
    return 0;
  }

  /** THE EFFECTS THE SOURCE ASKED FOR ARE RECORDED AND NOT NARROWED, so what this probe asserts is
   *  the program's own mask. Which effect TAKES PLACE is the kernel's (`src/kernel/dataobj.mjs`
   *  picks COPY whenever the mask holds it), and the receipt below is scripted so a run can drive
   *  the MOVE case the program must complete. */
  drag(fd, win, effects) {
    const o = this.objects.get(fd);
    if (!o) return -E.EBADF;
    o.sealed = true;
    this.drags.push({ win, effects });
    return 0;
  }

  /** A payload PUBLISHED AS A DROP for this run, so the target half can be driven without a second
   *  process. `where` is refused for anything else, which is `dataobj_open`'s own rule. */
  publishDrop(formats, payloads) {
    const made = this.create(formats);
    for (const [format, bytes] of payloads) this.set(made.fd, format, bytes);
    this.drop = this.objects.get(made.fd);
    this.drop.sealed = true;
    return made.fd;
  }

  open(where) {
    const slot = where === DOBJ_WHERE_CLIPBOARD ? this.clipboard
      : where === DOBJ_WHERE_DROP ? this.drop : undefined;
    if (slot === undefined) return -E.EINVAL;
    if (!slot) return -E.ENOENT;
    const fd = this.nextFd;
    this.nextFd += 1;
    this.objects.set(fd, slot);
    return { fd, offer: slot.offer };
  }
}

/* ---- the window, and the scripted event stream --------------------------------------------- */

const WIN_ID = 7;

class FakeWin {
  constructor(script) {
    this.script = [...script, [keyEvent("q")]];
    this.menus = [];
    this.draws = [];
    this.titles = [];
  }

  create() { return { win: WIN_ID, fd: 3 }; }
  destroy() { return [WIN_ID]; }
  setTitle(fd, t) { this.titles.push(String(t)); return 0; }
  surface() { return 0; }
  draw(fd, ops) { this.draws.push(ops); return 0; }
  menu(fd, x, y, items) {
    this.menus.push({ x, y, items: items.map((r) => ({ ...r })) });
    return items.length;
  }

  read() { return this.script.length > 0 ? this.script.shift() : []; }
  pending() { return this.script.length > 0; }
}

const keyEvent = (ch) => {
  const packed = packKeyBytes(std.bytes(ch));
  return { type: WEV_KEY, mods: 0, a: packed.a, b: packed.b, c: 0 };
};
const keysymEvent = (sym, mods = 0) => ({ type: WEV_KEY, mods, a: 0, b: 0, c: sym });
const pressEvent = (xCss, yCss, buttons = 1, mods = 0) => ({
  type: WEV_POINTER, mods: WPTR_DOWN | mods, a: Math.round(xCss), b: Math.round(yCss), c: buttons,
});
const moveEvent = (xCss, yCss, mods = 0) => ({
  type: WEV_POINTER, mods: WPTR_MOVE | mods, a: Math.round(xCss), b: Math.round(yCss), c: 1,
});
const releaseEvent = (xCss, yCss) => ({
  type: WEV_POINTER, mods: WPTR_UP, a: Math.round(xCss), b: Math.round(yCss), c: 0,
});
const itemEvent = (index, flags = 0) => ({
  type: WEV_ITEM, mods: 0, a: index, b: flags, c: WITEM_CONTEXT,
});
const dropEvent = (xCss, yCss, offer) => ({
  type: WEV_DROP, mods: 0, a: Math.round(xCss), b: Math.round(yCss), c: offer,
});
const doneEvent = (effect, target) => ({
  type: WEV_DRAG_DONE, mods: 0, a: effect, b: target, c: 0,
});

/** Run `files` with a scripted event stream. `S` is 1 for the whole run — no `WEV_CLIENT` is
 *  delivered — so a CSS pixel and a surface pixel are the same number and a press can be aimed with
 *  `FILES_METRICS.rowMid` directly. The dpr case is the browser page's. */
function drive(fs, data, argv, script) {
  const out = [];
  const win = new FakeWin(script);
  const env = {
    argv: ["files", ...argv],
    fs,
    data,
    win,
    proc: { spawn: () => 42, nanosleep: () => 0 },
    tty: { poll: () => ({ fds: [{ revents: POLLIN }] }) },
    std,
    write: (fd, bytes) => { out.push(std.text(bytes)); return bytes.length; },
  };
  const account = runFiles(env);
  return { account, win, stdout: out.join("") };
}

const HOME = "/Users/Default";
const BIN = FILES_METRICS.binDirIn(HOME);
const ORIGIN = FILES_METRICS.originRecordOf;

/** A fresh tree per section: a verb that ran in the section above is state this one did not ask
 *  for. `/tmp/out` is the OUTSIDE-the-session-tree case, which is where a delete is final. */
const freshFs = () => {
  const fs = new RealFs();
  fs.seedDir("/Users");
  fs.seedDir(HOME);
  fs.seedFile(`${HOME}/doomed.txt`, "doomed\n");
  fs.seedFile(`${HOME}/keep.txt`, "keep\n");
  fs.seedFile(`${HOME}/logo.rgba`, "rgba-ish\n");
  fs.seedDir(`${HOME}/full`);
  fs.seedFile(`${HOME}/full/child.txt`, "child\n");
  fs.seedDir("/tmp");
  fs.seedDir("/tmp/out");
  fs.seedFile("/tmp/out/gone.txt", "gone\n");
  fs.seedDir("/tmp/out/full");
  fs.seedFile("/tmp/out/full/child.txt", "child\n");
  return fs;
};

const rowOf = (account, name) => account.rows.findIndex((r) => r.name === name);
/** The y a row of this name is drawn at, CSS px — from the program's OWN report and its OWN
 *  geometry, never from a constant of this file's (`FILES_METRICS.rowMid`). */
const yOf = (account, name) => FILES_METRICS.rowMid(rowOf(account, name));

/** A listing the program is not involved in: what the filesystem holds, by name. */
const listing = (fs, path) => fs.namesIn(path);

/* =====================================================================================
   1. A DELETE LEAVES THE BYTES REACHABLE FROM THE BIN, AND A RESTORE RETURNS THEM
   ===================================================================================== */
{
  const fs = freshFs();
  const data = new FakeData();
  // The row is clicked and the Delete key pressed, which is a reader's own route — and the SAME
  // `runVerb` a menu row reaches, so the key is the cheaper half to drive.
  const first = drive(fs, data, [HOME], []);
  const y = yOf(first.account, "doomed.txt");
  const deleted = drive(fs, data, [HOME], [
    [pressEvent(40, y), releaseEvent(40, y)],
    [keysymEvent(WKEY_DELETE)],
  ]);

  // THE TWO RECORDS, READ OUT OF THE FILESYSTEM AND NOT OUT OF THE ACCOUNT.
  check("the delete left the payload in the Bin", fs.kindAt(`${BIN}/doomed.txt`), T_FILE);
  check("and its bytes are the ones that were deleted", fs.textAt(`${BIN}/doomed.txt`), "doomed\n");
  check("and the origin record is a SYMLINK to where it came from",
    fs.linkAt(ORIGIN(`${BIN}/doomed.txt`)), `${HOME}/doomed.txt`);
  check("and the original path is gone", fs.kindAt(`${HOME}/doomed.txt`), -E.ENOENT);
  check("and the program named the pair",
    deleted.account.bin.binned.map((b) => [b.name, b.from]),
    [["doomed.txt", `${HOME}/doomed.txt`]]);
  check("and nothing was removed permanently", deleted.account.bin.permanent, 0);

  // THE BIN LISTS THE PAYLOAD AND NOT THE RECORD, which is the join running in the one direction
  // that leaves no bytes invisible.
  const binned = drive(fs, data, [BIN], []);
  check("the Bin lists the payload and not the record",
    binned.account.rows.map((r) => r.name), ["doomed.txt"]);
  check("and the row carries its origin",
    binned.account.rows.map((r) => r.origin), [`${HOME}/doomed.txt`]);
  check("and the program says it is listing the Bin", binned.account.bin.listing, true);

  // RESTORE, from the Bin's own context menu: the row is right-clicked, the menu's first row is
  // `Restore`, and the item report runs it.
  const ry = yOf(binned.account, "doomed.txt");
  const restored = drive(fs, data, [BIN], [
    [pressEvent(40, ry, 2)],
    [itemEvent(0, 0)],
  ]);
  check("the Bin's row menu offers Restore first",
    restored.win.menus.map((m) => m.items[0].label), ["Restore"]);
  check("and the restore chose that verb", restored.account.chosen, [FILES_METRICS.VERBS.RESTORE]);
  check("the restore put the bytes back where they came from",
    fs.textAt(`${HOME}/doomed.txt`), "doomed\n");
  check("and the payload is gone from the Bin", fs.kindAt(`${BIN}/doomed.txt`), -E.ENOENT);
  check("and the origin record went with it",
    fs.kindAt(ORIGIN(`${BIN}/doomed.txt`)), -E.ENOENT);
  check("and the Bin is empty", listing(fs, BIN), []);
  check("and the program named the destination",
    restored.account.bin.restored.map((r) => [r.name, r.to]),
    [["doomed.txt", `${HOME}/doomed.txt`]]);
  check("and no record was stranded", restored.account.bin.stranded, 0);
}

/* =====================================================================================
   2. A RESTORE ONTO AN OCCUPIED PATH REFUSES BY NAME, AND `--restore-overwrites` DOES NOT
   ===================================================================================== */
const occupied = (argv) => {
  const fs = freshFs();
  const data = new FakeData();
  const first = drive(fs, data, [HOME], []);
  const y = yOf(first.account, "doomed.txt");
  drive(fs, data, [HOME], [[pressEvent(40, y), releaseEvent(40, y)],
    [keysymEvent(WKEY_DELETE)]]);
  // THE READER MAKES A NEW FILE OF THE SAME NAME WHILE THE OLD ONE IS IN THE BIN, which is the
  // whole case: the origin path is occupied by bytes the delete never saw.
  fs.seedFile(`${HOME}/doomed.txt`, "mine now\n");
  const binned = drive(fs, data, [BIN], []);
  const ry = yOf(binned.account, "doomed.txt");
  const run = drive(fs, data, [BIN, ...argv], [
    [pressEvent(40, ry, 2)],
    [itemEvent(0, 0)],
  ]);
  return { fs, run };
};
{
  const { fs, run } = occupied([]);
  const refusal = run.account.refusals.find((r) => r.what === "doomed.txt");
  check("a restore onto an occupied path refuses by name",
    refusal ? [refusal.what, refusal.errno] : null, ["doomed.txt", "EEXIST"]);
  check("and the reader's own file is untouched", fs.textAt(`${HOME}/doomed.txt`), "mine now\n");
  check("and the payload is still in the Bin", fs.textAt(`${BIN}/doomed.txt`), "doomed\n");
  check("and its origin record is still there",
    fs.linkAt(ORIGIN(`${BIN}/doomed.txt`)), `${HOME}/doomed.txt`);
  check("and nothing was restored", run.account.bin.restored, []);
}
{
  // THE CONTROL'S WORLD: the pre-check gone, and `vfs.rename` clobbering because that is what it
  // does — the reader's file is destroyed by a restore that reports success.
  const { fs, run } = occupied(["--restore-overwrites"]);
  check("`--restore-overwrites` refuses nothing", run.account.refusals.length, 0);
  check("and it DESTROYS the reader's own file", fs.textAt(`${HOME}/doomed.txt`), "doomed\n");
  check("and it reports the restore as done",
    run.account.bin.restored.map((r) => r.name), ["doomed.txt"]);
  check("and the control is reported in force", run.account.controls.restoreOverwrites, true);
}

/* =====================================================================================
   3. A DELETE OUTSIDE THE SESSION TREE IS STILL FINAL, AND STILL ANSWERS ENOTEMPTY
   ===================================================================================== */
{
  const fs = freshFs();
  const data = new FakeData();
  const first = drive(fs, data, ["/tmp/out"], []);
  const gy = yOf(first.account, "gone.txt");
  const run = drive(fs, data, ["/tmp/out"], [
    [pressEvent(40, gy), releaseEvent(40, gy)],
    [keysymEvent(WKEY_DELETE)],
  ]);
  check("a delete outside the session tree removes the file",
    fs.kindAt("/tmp/out/gone.txt"), -E.ENOENT);
  check("and it is counted as permanent", run.account.bin.permanent, 1);
  check("and nothing went to the Bin", run.account.bin.binned, []);
  check("and no Bin was created", fs.kindAt(BIN), -E.ENOENT);

  const second = drive(fs, data, ["/tmp/out"], []);
  const fy = yOf(second.account, "full");
  const full = drive(fs, data, ["/tmp/out"], [
    [pressEvent(40, fy), releaseEvent(40, fy)],
    [keysymEvent(WKEY_DELETE)],
  ]);
  const refusal = full.account.refusals.find((r) => r.what === "full");
  check("and a non-empty folder there still answers ENOTEMPTY",
    refusal ? [refusal.what, refusal.errno] : null, ["full", "ENOTEMPTY"]);
  check("and the folder and its child are untouched",
    [fs.kindAt("/tmp/out/full"), fs.textAt("/tmp/out/full/child.txt")], [T_DIR, "child\n"]);
}

/* =====================================================================================
   4. A NON-EMPTY FOLDER IN THE SESSION TREE GOES TO THE BIN WHOLE
   ===================================================================================== */
{
  const fs = freshFs();
  const data = new FakeData();
  const first = drive(fs, data, [HOME], []);
  const fy = yOf(first.account, "full");
  const run = drive(fs, data, [HOME], [
    [pressEvent(40, fy), releaseEvent(40, fy)],
    [keysymEvent(WKEY_DELETE)],
  ]);
  check("a non-empty folder in the session tree goes to the Bin",
    fs.kindAt(`${BIN}/full`), T_DIR);
  check("and its whole subtree went with it, in one rename",
    fs.textAt(`${BIN}/full/child.txt`), "child\n");
  check("and nothing was refused", run.account.refusals, []);
  check("and the origin record names the folder",
    fs.linkAt(ORIGIN(`${BIN}/full`)), `${HOME}/full`);
}

/* =====================================================================================
   5. A SECOND DELETE OF ONE NAME IS NUMBERED, AND THE RECORD'S NAME IS RESERVED
   ===================================================================================== */
{
  const fs = freshFs();
  const data = new FakeData();
  const binIt = (name) => {
    const seen = drive(fs, data, [HOME], []);
    const y = yOf(seen.account, name);
    return drive(fs, data, [HOME], [
      [pressEvent(40, y), releaseEvent(40, y)],
      [keysymEvent(WKEY_DELETE)],
    ]);
  };
  binIt("doomed.txt");
  fs.seedFile(`${HOME}/doomed.txt`, "the second one\n");
  const second = binIt("doomed.txt");
  check("a second delete of one name is numbered",
    second.account.bin.binned.map((b) => b.name), ["doomed.txt (2)"]);
  check("and both payloads are in the Bin with their own bytes",
    [fs.textAt(`${BIN}/doomed.txt`), fs.textAt(`${BIN}/doomed.txt (2)`)],
    ["doomed\n", "the second one\n"]);
  check("and each has its own origin record",
    [fs.linkAt(ORIGIN(`${BIN}/doomed.txt`)), fs.linkAt(ORIGIN(`${BIN}/doomed.txt (2)`))],
    [`${HOME}/doomed.txt`, `${HOME}/doomed.txt`]);
  check("and the Bin holds exactly four entries", listing(fs, BIN).length, 4);

  // A FILE WHOSE NAME IS A RECORD'S NAME. `freeFrom`'s `reserve` is what stops the payload taking
  // a name whose record would overwrite a standing one.
  fs.seedFile(`${HOME}/doomed.txt.origin`, "not a record\n");
  const third = binIt("doomed.txt.origin");
  check("a file named like a record does not take a name whose record is taken",
    third.account.bin.binned.map((b) => b.name), ["doomed.txt.origin (2)"]);
  check("and the standing record still points where it did",
    fs.linkAt(ORIGIN(`${BIN}/doomed.txt`)), `${HOME}/doomed.txt`);
  check("and the file's own bytes are in the Bin",
    fs.textAt(`${BIN}/doomed.txt.origin (2)`), "not a record\n");
}

/* =====================================================================================
   6. A DELETE INSIDE THE BIN IS FINAL — WHICH IS HOW A READER EMPTIES IT
   ===================================================================================== */
{
  const fs = freshFs();
  const data = new FakeData();
  const first = drive(fs, data, [HOME], []);
  const y = yOf(first.account, "doomed.txt");
  drive(fs, data, [HOME], [[pressEvent(40, y), releaseEvent(40, y)], [keysymEvent(WKEY_DELETE)]]);
  const binned = drive(fs, data, [BIN], []);
  const ry = yOf(binned.account, "doomed.txt");
  const run = drive(fs, data, [BIN], [
    [pressEvent(40, ry), releaseEvent(40, ry)],
    [keysymEvent(WKEY_DELETE)],
  ]);
  check("a delete inside the Bin removes the payload", fs.kindAt(`${BIN}/doomed.txt`), -E.ENOENT);
  check("and it is counted as permanent", run.account.bin.permanent, 1);
  check("and it was not re-binned", run.account.bin.binned, []);
  /* AND THE RECORD IS LEFT STANDING, which is the one place this design leaks and it is counted
   * rather than hidden: a payload removed inside the Bin leaves its origin record, which the next
   * listing reports as stranded and draws no row for. It names nothing a reader can act on. */
  const after = drive(fs, data, [BIN], []);
  check("and the orphaned record is reported as stranded, not drawn",
    [after.account.rows.length, after.account.bin.strandedRecords], [0, 1]);
}

/* =====================================================================================
   7. F5 RE-LISTS, AND THE SELECTION SURVIVES FOR THE ROWS THAT SURVIVE
   ===================================================================================== */
{
  const fs = freshFs();
  const data = new FakeData();
  const first = drive(fs, data, [HOME], []);
  const ky = yOf(first.account, "keep.txt");
  const dy = yOf(first.account, "doomed.txt");
  /* TWO ROWS SELECTED, THEN ONE OF THEM REMOVED UNDER THE WINDOW BY A SECOND PROCESS — which is
   * what F5 is for. The removal is done by the FILESYSTEM between two batches, not by this
   * program, so the listing in hand is genuinely stale. */
  const win = new FakeWin([
    [pressEvent(40, ky), releaseEvent(40, ky)],
    [pressEvent(40, dy, 1, WMOD_CTRL)],
    [{ type: 0, mods: 0, a: 0, b: 0, c: 0 }],
    [keysymEvent(WKEY_F5)],
  ]);
  // The third batch is a no-op event the program ignores; the removal rides the poll before it.
  let removed = false;
  const out = [];
  const env = {
    argv: ["files", HOME],
    fs,
    data,
    win,
    proc: { spawn: () => 42, nanosleep: () => 0 },
    tty: {
      poll: () => {
        if (win.script.length === 2 && !removed) {
          removed = true;
          fs.unlink(`${HOME}/doomed.txt`);
        }
        return { fds: [{ revents: POLLIN }] };
      },
    },
    std,
    write: (fd, bytes) => { out.push(std.text(bytes)); return bytes.length; },
  };
  const account = runFiles(env);
  check("the file really went away under the window",
    [removed, fs.kindAt(`${HOME}/doomed.txt`)], [true, -E.ENOENT]);
  check("F5 was counted once", account.refreshes, 1);
  check("and the listing came back without the row that is gone",
    account.rows.some((r) => r.name === "doomed.txt"), false);
  check("and the row that survived is still selected",
    account.selected.map((i) => account.rows[i].name), ["keep.txt"]);
  check("and the selection that pointed at the missing row did not resurrect it",
    [account.refreshKept, account.selected.length], [1, 1]);
}
{
  // `--stale-listing`: the keysym still arrives, the listing does not change.
  const fs = freshFs();
  const data = new FakeData();
  const win = new FakeWin([[keysymEvent(WKEY_F5)]]);
  const out = [];
  let removed = false;
  const env = {
    argv: ["files", "--stale-listing", HOME],
    fs,
    data,
    win,
    proc: { spawn: () => 42, nanosleep: () => 0 },
    tty: {
      poll: () => {
        if (!removed) { removed = true; fs.unlink(`${HOME}/doomed.txt`); }
        return { fds: [{ revents: POLLIN }] };
      },
    },
    std,
    write: (fd, bytes) => { out.push(std.text(bytes)); return bytes.length; },
  };
  const account = runFiles(env);
  check("`--stale-listing` still counts the F5", account.refreshes, 1);
  check("and still serves the row that is gone",
    account.rows.some((r) => r.name === "doomed.txt"), true);
  check("and the control is reported in force", account.controls.staleListing, true);
}

/* =====================================================================================
   8. A DROP LANDS BYTES IN THIS DIRECTORY, AND INTO A DIRECTORY ROW UNDER THE POINTER
   ===================================================================================== */
{
  const fs = freshFs();
  const data = new FakeData();
  fs.seedDir("/tmp/src");
  fs.seedFile("/tmp/src/dropped.txt", "from elsewhere\n");
  const offerFd = data.publishDrop([DOBJ_PATHS], [[DOBJ_PATHS, std.bytes("/tmp/src/dropped.txt")]]);
  const offer = data.objects.get(offerFd).offer;
  const first = drive(fs, data, [HOME], []);
  // AIMED AT THE HEADER'S OWN STRIP, which is outside the viewport: a drop there lands in the open
  // directory, which is the case a reader hits most.
  const run = drive(fs, data, [HOME], [
    [{ type: WEV_DRAG_ENTER, mods: 0, a: 10, b: 2, c: offer }],
    [dropEvent(40, 2, offer)],
  ]);
  check("the drop was counted with its offer",
    [run.account.dropsIn, run.account.dragEnters,
      run.account.dragOffers.map((o) => `${o.at}:${o.formats.join("+")}`)],
    [1, 1, ["enter:paths", "drop:paths"]]);
  check("and the bytes landed in the open directory",
    fs.textAt(`${HOME}/dropped.txt`), "from elsewhere\n");
  check("and the source is untouched: a drop is a COPY-IN",
    fs.textAt("/tmp/src/dropped.txt"), "from elsewhere\n");
  check("and the program named where it landed",
    run.account.dropped.map((d) => [d.name, d.into]), [["dropped.txt", HOME]]);
  check("and the new row is in the re-read listing and selected",
    run.account.selected.map((i) => run.account.rows[i].name), ["dropped.txt"]);

  // A SECOND DROP OF THE SAME NAME IS REFUSED BY THE KERNEL'S OWN EEXIST, through `O_EXCL`.
  const again = drive(fs, data, [HOME], [[dropEvent(40, 2, offer)]]);
  const refusal = again.account.refusals.find((r) => r.what === "dropped.txt");
  check("a drop onto a name the directory holds says EEXIST",
    refusal ? [refusal.what, refusal.errno] : null, ["dropped.txt", "EEXIST"]);
  check("and nothing landed", again.account.dropped, []);
  check("and the standing file's bytes are its own",
    fs.textAt(`${HOME}/dropped.txt`), "from elsewhere\n");

  // AND A DROP ON A DIRECTORY ROW LANDS IN THAT DIRECTORY.
  const seen = drive(fs, data, [HOME], []);
  const fy = yOf(seen.account, "full");
  const into = drive(fs, data, [HOME], [[dropEvent(40, fy, offer)]]);
  check("a drop on a directory row lands in that directory",
    fs.textAt(`${HOME}/full/dropped.txt`), "from elsewhere\n");
  check("and the program named the row it landed on",
    into.account.dropWhere.map((w) => w.into), [`${HOME}/full`]);
}
{
  // A FORMAT WITH NO PATH LIST IS REFUSED BY NAME. This window takes a path list and nothing else:
  // a dropped image has no name to land under.
  const fs = freshFs();
  const data = new FakeData();
  const fd = data.publishDrop([DOBJ_TEXT], [[DOBJ_TEXT, std.bytes("just words")]]);
  const offer = data.objects.get(fd).offer;
  const run = drive(fs, data, [HOME], [[dropEvent(40, 2, offer)]]);
  const refusal = run.account.refusals.find((r) => r.what === "a drop");
  check("a drop with no path list is refused by name",
    refusal ? refusal.why : null, "offered text and no path list");
  check("and nothing landed", run.account.dropped, []);
}

/* =====================================================================================
   9. THE EFFECT A DRAG OFFERS, AND WHAT A MOVE RECEIPT DOES
   ===================================================================================== */
const dragFrom = (dirPath, name, argv, mods) => {
  const fs = freshFs();
  const data = new FakeData();
  const seen = drive(fs, data, [dirPath], []);
  const y = yOf(seen.account, name);
  const run = drive(fs, data, [dirPath, ...argv], [
    [pressEvent(40, y), moveEvent(80, y, mods)],
    [doneEvent(data.drags.length >= 0 ? DOBJ_EFFECT_MOVE : 0, 9)],
  ]);
  return { fs, data, run };
};
{
  const { data, run } = dragFrom(HOME, "logo.rgba", [], 0);
  check("a plain drag of a row in the session tree offers a MOVE",
    run.account.effectsOffered.map((e) => e.effect), [DOBJ_EFFECT_MOVE]);
  check("and the mask the kernel was handed is that alone",
    data.drags.map((d) => d.effects), [DOBJ_EFFECT_MOVE]);
}
{
  const { data } = dragFrom(HOME, "logo.rgba", [], WMOD_CTRL);
  check("ctrl forces a COPY", data.drags.map((d) => d.effects), [DOBJ_EFFECT_COPY]);
}
{
  const { data } = dragFrom(HOME, "logo.rgba", ["--move-forced-copy"], 0);
  check("`--move-forced-copy` offers a COPY whatever the modifier",
    data.drags.map((d) => d.effects), [DOBJ_EFFECT_COPY]);
}
{
  // THE ROW OUTSIDE THE SESSION TREE, which is M10's own source window (`files /usr/share`): there
  // is no Bin to put the original in, so a plain drag can only be a copy.
  const fs = freshFs();
  const data = new FakeData();
  fs.seedDir("/tmp/ro");
  fs.seedFile("/tmp/ro/logo.rgba", "rgba-ish\n");
  const seen = drive(fs, data, ["/tmp/ro"], []);
  const y = yOf(seen.account, "logo.rgba");
  drive(fs, data, ["/tmp/ro"], [[pressEvent(40, y), moveEvent(80, y)]]);
  check("a plain drag of a row outside the session tree offers a COPY",
    data.drags.map((d) => d.effects), [DOBJ_EFFECT_COPY]);
}
{
  // THE RECEIPT. A MOVE says the drop was DELIVERED and not that it was collected, so the original
  // goes to the Bin and is one Restore away rather than gone.
  const { fs, run } = dragFrom(HOME, "logo.rgba", [], 0);
  check("a MOVE receipt took the original out of the directory",
    fs.kindAt(`${HOME}/logo.rgba`), -E.ENOENT);
  check("and put it in the Bin, with its origin record",
    [fs.textAt(`${BIN}/logo.rgba`), fs.linkAt(ORIGIN(`${BIN}/logo.rgba`))],
    ["rgba-ish\n", `${HOME}/logo.rgba`]);
  check("and the program named it as moved out", run.account.movedOut, ["logo.rgba"]);
  check("and the effect it reports is the kernel's",
    run.account.effects.map((e) => e.effect), [DOBJ_EFFECT_MOVE]);
}
{
  // A DROP ON THIS WINDOW'S OWN WINDOW MOVES NOTHING, because `landOne` already refused it.
  const fs = freshFs();
  const data = new FakeData();
  const seen = drive(fs, data, [HOME], []);
  const y = yOf(seen.account, "logo.rgba");
  const run = drive(fs, data, [HOME], [
    [pressEvent(40, y), moveEvent(80, y)],
    [doneEvent(DOBJ_EFFECT_MOVE, WIN_ID)],
  ]);
  const refusal = run.account.refusals.find((r) => r.what === "logo.rgba");
  check("a MOVE reported against this window's own window moves nothing",
    [fs.kindAt(`${HOME}/logo.rgba`), run.account.movedOut.length], [T_FILE, 0]);
  check("and it is refused by name", refusal ? refusal.why : null,
    "was dropped on its own window, so there is nothing to move");
}
{
  /* ...BUT A DROP ON A DIRECTORY ROW OF THIS SAME WINDOW IS A MOVE, which is Explorer's commonest
   * one. The drop lands the bytes in the folder and the receipt then takes the original out: both
   * halves, in one window, with the target winid the SAME. */
  const fs = freshFs();
  const data = new FakeData();
  const seen = drive(fs, data, [HOME], []);
  const ry = yOf(seen.account, "logo.rgba");
  const fy = yOf(seen.account, "full");
  const offer = data.objects.get(
    data.publishDrop([DOBJ_PATHS], [[DOBJ_PATHS, std.bytes(`${HOME}/logo.rgba`)]])).offer;
  const run = drive(fs, data, [HOME], [
    [pressEvent(40, ry), moveEvent(80, fy)],
    [dropEvent(40, fy, offer)],
    [doneEvent(DOBJ_EFFECT_MOVE, WIN_ID)],
  ]);
  check("a drop on a directory row of its OWN window lands the bytes there",
    fs.textAt(`${HOME}/full/logo.rgba`), "rgba-ish\n");
  check("and the receipt completes the move: the original is out of the directory",
    fs.kindAt(`${HOME}/logo.rgba`), -E.ENOENT);
  check("and it is in the Bin rather than unlinked",
    fs.textAt(`${BIN}/logo.rgba`), "rgba-ish\n");
  check("and nothing was refused", run.account.refusals, []);
}

/* =====================================================================================
   10. RESTORE IS A VERB OF THE BIN AND NOWHERE ELSE
   ===================================================================================== */
{
  const fs = freshFs();
  const data = new FakeData();
  const seen = drive(fs, data, [HOME], []);
  const y = yOf(seen.account, "keep.txt");
  const run = drive(fs, data, [HOME], [[pressEvent(40, y, 2)]]);
  check("a row menu outside the Bin carries no Restore",
    run.win.menus.map((m) => m.items.map((r) => r.label).filter((l) => l !== "")),
    [["Open", "Cut", "Copy", "Delete", "Rename"]]);
  check("and it is the same five rows M20 asserted, in seven records",
    run.win.menus.map((m) => m.items.length), [7]);
}
{
  // AND A PAYLOAD WITH NO RECORD HAS ITS Restore DRAWN DISABLED, because there is no destination to
  // name and a live row that refused would tell the reader nothing until after they pressed it.
  const fs = freshFs();
  const data = new FakeData();
  fs.seedDir(BIN);
  fs.seedFile(`${BIN}/orphan.txt`, "no record\n");
  const seen = drive(fs, data, [BIN], []);
  const y = yOf(seen.account, "orphan.txt");
  const run = drive(fs, data, [BIN], [[pressEvent(40, y, 2)], [itemEvent(0, 0)]]);
  check("a payload with no origin record has Restore DISABLED",
    run.win.menus.map((m) => (m.items[0].flags & WITEM_DISABLED) !== 0), [true]);
  const refusal = run.account.refusals.find((r) => r.what === "orphan.txt");
  check("and a report against it is refused by name with the readlink's errno",
    refusal ? [refusal.what, refusal.errno] : null, ["orphan.txt", "ENOENT"]);
  check("and the payload is still in the Bin", fs.textAt(`${BIN}/orphan.txt`), "no record\n");
}

/* ---- the verdict --------------------------------------------------------------------------- */

const scored = results.map((r) => ({ ...r, ok: INVERT ? !r.ok : r.ok }));
const failed = scored.filter((r) => !r.ok);
for (const r of scored) {
  const line = `${r.ok ? "ok  " : "BAD "}${r.name}`;
  console.log(r.ok ? line : `${line}\n     got ${JSON.stringify(r.got ?? r.detail)}`
    + `${r.want === undefined ? "" : `\n     want ${JSON.stringify(r.want)}`}`);
}
console.log(`\n${scored.length - failed.length}/${scored.length} expectations`
  + `${INVERT ? " (INVERTED)" : ""}`);
if (INVERT) {
  /* A PROOF THAT SUCCEEDED EXITS 0, which is `scripts/check.py --prove-failure`'s own convention:
   * non-zero is reserved for a proof that failed to fail. The number that matters is how many
   * clauses were ALREADY failing before the inversion — those are the ones that cannot be shown
   * capable of failing by inverting them. */
  const flipped = results.length - results.filter((r) => r.ok).length;
  console.log(`--prove-failure: ${results.length} expectation(s) inverted, `
    + `${flipped} were already failing`);
  process.exit(flipped === 0 ? 0 : 1);
}
process.exit(failed.length === 0 ? 0 : 1);
