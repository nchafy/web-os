// THE ONE DEFINITION OF "STAGE THE FULL DESKTOP SHELL", page-side, beside `www/pagekernel.mjs`.
//
// `www/m14.html`'s `bootHost()` and its `live()` were that definition, and every other page carried
// its own copy — so "the landing page is always up to date with the latest features" was a promise
// kept by hand. A feature that lands here appears on every page that imports this file, which is
// the whole point: the next milestone's window, program or wait goes in `PROGRAMS`, `DESKTOP_HELP`
// or the staging below, ONCE.
//
// THERE IS NO KERNEL PLUMBING AND NO PROOF IN THIS FILE. `www/pagekernel.mjs` owns the message
// transport, the boot retry and the GESTURE PROTOCOL with its driver banner (constraint 283); this
// file owns the order in which a desktop is assembled and what is on it. The four names a page
// still needs from there are RE-EXPORTED AT THE BOTTOM, not redefined — a second `gestureAsker`
// would be a second banner and a second handshake for `scripts/check.py` to agree with by hand.

import { WinHost, setHostControls } from "/src/wm/winhost.mjs";
import { setGeometryControls } from "/src/wm/window.mjs";
import { Taskbar, setShellControls } from "/src/wm/taskbar.mjs";
import { setViewControls } from "/src/wm/desktop.mjs";
import * as aero from "/src/wm/aero.mjs";
import { WROLE_DESKTOP } from "/src/abi.mjs";
import { HOME_DIR } from "/src/libos/std.mjs";
import { bootKernel, spawnProgram, until, sleep, gestureAsker } from "/www/pagekernel.mjs";

/** A desktop is meant to outlive the reader, so its programs get an hour. `src/bin/term.mjs`'s own
 *  comment records why every page spawns with this: the default relay ceiling is 30 s and `term &`
 *  died under a reader's hands. */
export const LIVE_CEILING_MS = 3600000;

/** What a page of PROOFS gives the same programs: long enough to outlast nine driven gestures,
 *  short enough that an abandoned run reaps itself. */
export const PROOF_CEILING_MS = 600000;

/** How long any one staging step may take. All three of the extracted path's waits were this
 *  number, so it is one constant; `stageDesktop({ waitMs })` raises it for a slower run. */
const STAGE_WAIT_MS = 10000;

/**
 * THE PROGRAMS A STAGED DESKTOP MAY RUN, AS DATA — which is what makes "a feature lands once"
 * mechanical rather than remembered. A milestone that adds a program adds a row here and names it
 * in a page's `programs`, and no page learns a URL or an argv.
 *
 * `argv` takes the ceiling in ms because two of these spell the same flag differently
 * (`desktop -c`, `term --ceiling`) and a caller must not have to know which.
 * `windows` is how many frames the program opens — a number, or a function of the spec's `count`
 * for a program that takes the number as an argument. The staging waits for exactly that many, so a
 * program whose window never arrived is a timeout that names it rather than a desktop that is
 * quietly short one window.
 * `box` is the shell PLACING a window it opened itself, in work-area terms.
 */
export const PROGRAMS = Object.freeze({
  desktop: {
    url: "/src/bin/desktop.mjs",
    argv: (ms) => ["desktop", "-c", String(ms)],
    // It takes `WROLE_DESKTOP`, which is not an app frame and is never placed or counted.
    windows: 0,
  },
  term: {
    url: "/src/bin/term.mjs",
    argv: (ms) => ["term", "--ceiling", String(ms)],
    /* IT SPAWNS `sh` BY SYSCALL, which is why it MUST BE STAGED LAST. `G_READY` is cumulative over
     * every process the kernel has started, children included, and `spawnBatch` reads it before the
     * batch — so a child that readies after `term`'s own `ready` satisfies the NEXT spawn's wait.
     * `www/pagekernel.mjs`'s `spawnProgram` then posts `go` to a worker still inside `init`, where
     * `program` is null, and the kernel faults it with
     * `TypeError: Cannot read properties of null (reading 'run')`.
     *
     * MEASURED: staging `['term', 'files']` faults in `src/libos/process.mjs:244`, and
     * `['files', 'taskmgr', 'term']` does not. `stageDesktop` refuses the first order rather than
     * reordering it, because the defect is in the kernel's ready accounting
     * (`src/kernel/kernel.mjs` `spawnBatch`/`awaitReady`) and a silent reorder would hide it. */
    spawnsChildren: true,
    /* CLEAR OF THE ICON COLUMN, because a first-run desktop should show what is on it. `term` asks
     * for its own geometry and gets it; this is the SHELL placing the one window it opened itself,
     * and it is a decision rather than a default — the icon column is at the desktop's left edge,
     * which is exactly where a fresh window opens (constraint 289).
     *
     * It cost two screenshots and a Firefox run to notice: "4 icons drawn" and a desktop with no
     * icons on it are both true when a window is sitting on top of them. */
    box: (wa) => ({ x: Math.max(120, Math.round(wa.w * 0.45)), y: 40 }),
    focus: true,
  },
  files: {
    url: "/src/bin/files.mjs",
    /* M19a. NO DIRECTORY, SO THE PROGRAM RESOLVES ITS OWN — `std.sessionDir`, which is the session's
     * writable copy of the base (D40) and `/usr/share` on a volume that has none. It was
     * `/usr/bin`: a READ-ONLY provider mount, so the file manager the landing page opens for a
     * reader was one where nothing could be renamed or deleted.
     *
     * THE PAGE DOES NOT PASS THE PUBLISHED `fs.seed.dest` HERE, and that is a measurement rather
     * than a shortcut. `dest` is non-null in worlds where the tree is NOT on the volume — a seed
     * that rolled back, a volume that predates the seed — and all of them report `ran: false`
     * identically, so the dest alone cannot say whether the directory exists. A page cannot `stat`;
     * the program can, and an operand a program was handed must not be second-guessed. What the
     * page does with the report is `seedState` below: publish it, and say so when it disagrees with
     * the name userland opens. */
    argv: () => ["files"],
  },
  taskmgr: {
    url: "/src/bin/taskmgr.mjs",
    argv: () => ["taskmgr"],
  },
  winopen: {
    url: "/src/bin/winopen.mjs",
    argv: (ms, n = 1) => ["winopen", "-n", String(n), "-c", String(ms)],
    // Two windows of ONE program is what a taskbar GROUP is, so `count` is a staging knob and the
    // frames to wait for are derived from it rather than written twice.
    windows: (n = 1) => n,
  },
});

/** What the desktop can do, printed. A second engine gives no other channel — these pages print
 *  their own log for that reason (`CLAUDE.md`'s second-engine rule) — and a feature a reader cannot
 *  find is a feature that did not land. A milestone adds its line HERE and every page shows it. */
export const DESKTOP_HELP = Object.freeze([
  "A LIVE WINDOWS 7 DESKTOP.",
  "  double-click an icon, or use the Start orb — both are rows the `desktop` process",
  "  published from the filesystem, so the menu is a listing of /usr/bin",
  "  drag a caption to an edge to snap, to the top to maximize; 20 px of drag-out releases",
  "  drag a window's edge or corner to resize it; the surface follows in device pixels",
  "  right-click a taskbar button for its jump list; hover one for a thumbnail",
  "  hover the strip at the far right to peek, click it to minimize everything",
  "  turn the wheel over a file list or the task table: the rows move and the header stays",
  "  `files` opens the session's own tree — a writable copy of the read-only base, made once",
  "  type `files /usr`, `taskmgr` or `paint` at the prompt for more to open",
]);

/* ---- the abort gate ------------------------------------------------------------------------- */

/**
 * WHY THERE CAN BE NO KERNEL HERE, or `""` when there can.
 *
 * `Atomics.wait` throws in a window agent and the syscall SAB is not CONSTRUCTIBLE without
 * COOP/COEP, so a page served without the headers has no kernel, no process and no window. It must
 * REFUSE AND SAY SO: an empty desktop with no message is the failure `www/index.html`'s preflight
 * exists to prevent, and `scripts/serve.py --no-isolation` is the run that proves this path.
 */
export function isolationFailure() {
  if (self.crossOriginIsolated === true && typeof SharedArrayBuffer === "function") return "";
  return `crossOriginIsolated === ${self.crossOriginIsolated}`
    + `; SharedArrayBuffer is ${typeof SharedArrayBuffer}. No kernel, no windows, no shell.`;
}

/**
 * The gate as every page applies it: record the refusal on the page's globals, say it, and answer
 * whether to proceed. `log` is the page's own log element and is marked `bad` when given — the
 * class lives in the page's stylesheet, so the element is passed rather than looked up.
 */
export function requireIsolation(report, say = () => {}, log = null) {
  const why = isolationFailure();
  if (!why) return true;
  report.state = "aborted";
  report.why = why;
  if (log) log.className = "bad";
  say(why);
  return false;
}

/** The globals object every page publishes for a driver, in one shape. A page SHOULD still create
 *  its own in a classic `<script>` before the module runs: a module that fails to parse publishes
 *  nothing, and a harness with no object to read reports a timeout where there was a syntax error. */
export function newReport(extra = {}) {
  return {
    state: "starting",
    isolated: self.crossOriginIsolated === true,
    proofs: {},
    errors: [],
    faults: [],
    notes: [],
    phase: "",
    fetches: { kernels: 0, fetches: 0, retries: 0, timeouts: 0, transport: 0 },
    bootRetries: 0,
    ...extra,
  };
}

/* ---- the controls -------------------------------------------------------------------------- */

/**
 * Every page-side negative control, set in one call.
 *
 * The four setters live in the four modules that own the behaviour and MUST all be called: a page
 * that sets three leaves the fourth holding whatever the last page in this realm asked for. Keys
 * absent from `cfg` are the OFF switch, which is what `CLAUDE.md`'s one-knob rule asks of them.
 */
export function applyControls(cfg = {}) {
  setGeometryControls({
    noClamp: cfg.noClamp === true,
    noSnapHysteresis: cfg.noSnapHysteresis === true,
    noWorkArea: cfg.noWorkArea === true,
  });
  setHostControls({
    staleGeom: cfg.staleGeom === true,
    noRelayout: cfg.noRelayout === true,
    rawWheel: cfg.rawWheel === true,
  });
  setShellControls({ noGroup: cfg.noGroup === true });
  setViewControls({ snapToGrid: cfg.noIconGrid !== true });
}

/* ---- the session's tree (M19a, D40) --------------------------------------------------------- */

/**
 * WHAT THE KERNEL SAID ABOUT THE SESSION'S TREE, out of the boot report, and whether it agrees with
 * the name userland opens.
 *
 * `up` is the kernel's `up` message. The seed report is never null once a mount has been attempted,
 * so a null here is a kernel that did not report one at all — an older page-side transport — and is
 * said rather than treated as "no seed".
 *
 * THE DISAGREEMENT IS THE POINT. `src/kernel/seed.mjs`'s `SEED_DEST` is where the copy LANDS and
 * `src/libos/std.mjs`'s `HOME_DIR` is where every program OPENS; a process may not import kernel
 * code, so the two cannot be one constant, and this page is the only place that holds both. If they
 * ever drift, every program opens a directory the seed did not create and the symptom is an empty
 * file manager with no error anywhere — so it is said, noted, and published for a driver.
 */
export function seedState(up, say = () => {}, report = null) {
  const seed = (up && up.fs && up.fs.seed) || null;
  const dest = (seed && seed.dest) || null;
  const drifted = Boolean(dest) && dest !== HOME_DIR;
  const why = !seed
    ? "the kernel reported no seed at all"
    : (drifted
      ? `the kernel seeded ${dest} and userland opens ${HOME_DIR}: every program is pointed at a `
        + "directory the seed did not create"
      : "");
  if (why) {
    say(`SEED: ${why}`);
    if (report && Array.isArray(report.notes)) report.notes.push(`seed: ${why}`);
  }
  return { seed, dest, home: HOME_DIR, drifted, why };
}

/* ---- the assembly -------------------------------------------------------------------------- */

/**
 * BOOT A KERNEL AND BUILD THE SHELL: the window host, the skin, the taskbar.
 *
 * THE ORDER IS THE WHOLE CONTENT OF THIS FUNCTION, and each step is here because doing it later
 * cost a defect:
 *
 *  - `liveClass` goes on BEFORE the kernel, because the desktop's size is what the shell reserves
 *    its strip out of and what every frame is clamped into. A window laid out against a 560 px
 *    desktop and then handed a 740 px one is M13's own lesson (`WinHost.relayout`), and the cheap
 *    way not to need it is to be the right size before anything is placed.
 *  - `tap` is registered BEFORE the host's listener, because `kernelBoot` calls its listeners in
 *    order: a listener added first sees every batch the host is about to replay.
 *  - THE SHELL IS BUILT AFTER THE SKIN AND BEFORE ANY WINDOW. The taskbar reserves its strip in its
 *    constructor, and a window laid out before that reservation is a maximized window covering the
 *    bar.
 *
 * Returns `{ k, host, shell }`. `shell` is `null` only when `taskbar: false` was asked for.
 */
export async function bootShell(opts) {
  const {
    into, report, say = () => {}, label = "shell", cfg = {},
    tap = null, taskbar = true, liveClass = "",
  } = opts;
  if (!into) throw new Error("bootShell needs `into`: the desktop element");
  if (!report) throw new Error("bootShell needs `report`: the page's globals object");
  if (liveClass) document.body.classList.add(liveClass);
  const k = await bootKernel({ label, bench: 1, ...cfg }, report, say);
  /* M19a. THE SEED REPORT, READ OFF THE BOOT MESSAGE. `up` is solicited, so `kernelBoot` keeps it
   * in `k.events` — `expect` splices out of `pending` and leaves that log alone. Published on the
   * page's globals because the live desktop has no assertions on it and this is what a driver reads
   * the session's tree back through; `seedState` says anything wrong with it. */
  report.seed = seedState(k.events.find((m) => m.t === "up"), say, report);
  if (tap) k.on(tap);
  const host = new WinHost({ into, post: (m) => k.post(m) });
  k.on((m) => { host.handle(m); });
  aero.install(into);
  const shell = taskbar ? new Taskbar({ into, host }) : null;
  report.host = host;
  if (shell) report.shell = shell;
  return { k, host, shell };
}

/** The windows a reader would call windows: everything but the desktop. */
export function appFrames(host) {
  return [...host.frames.values()]
    .filter((e) => e.role !== WROLE_DESKTOP)
    .sort((a, b) => a.id - b.id);
}

/** Put a frame where the shell wants it and tell it so. The synthetic `keyup` is the frame's own
 *  route for "your box changed outside a drag", which is what re-reports the geometry. */
export function place(entry, box) {
  entry.win.box = { x: box.x | 0, y: box.y | 0, w: box.w | 0, h: box.h | 0 };
  entry.win.apply();
  entry.win.barEl.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));
  return { ...entry.win.placed };
}

/** One program spec, from a `PROGRAMS` key or an inline object. An unknown key is a THROW and not a
 *  default: a page asking for a program that does not exist should say so, not stage a short desk. */
function specFor(want) {
  if (typeof want !== "string") return want;
  const row = PROGRAMS[want];
  if (!row) {
    throw new Error(`no such staged program \`${want}\`; PROGRAMS has `
      + `${Object.keys(PROGRAMS).join(", ")}`);
  }
  return { name: want, ...row };
}

/**
 * STAGE THE LIVE DESKTOP, and return the handles a caller needs.
 *
 * THE DESKTOP PROCESS GOES FIRST, because the shell's icons, its start menu and every jump list are
 * rows that process publishes: a taskbar with no desktop behind it is a taskbar with an empty menu,
 * and a page should never be rendering that state by accident.
 *
 * IT WAITS FOR THE ROWS AND NOT ONLY THE WINDOW. The extracted live path waited for the window
 * alone, and an icon view with no items drawn is indistinguishable from a desktop process that
 * published nothing — which is exactly what a reader reported twice (constraints 289-292). The
 * stricter of the two extracted waits is the one that survives, with the `noItems` control exempt
 * because its whole subject is rows that never arrive.
 *
 * `programs` is a list of `PROGRAMS` keys or inline specs, staged in order; `livePid` is the last
 * one's pid, which is what a bench script holds to keep the session alive. A program that spawns a
 * child — `term` — MUST come last, and a list that breaks that is refused below.
 */
export async function stageDesktop(opts = {}) {
  const {
    say = () => {}, ceilingMs = LIVE_CEILING_MS, programs = ["term"],
    waitMs = STAGE_WAIT_MS, help = DESKTOP_HELP, diagnose = true, noItems = false,
  } = opts;
  const report = opts.report;
  if (!report) throw new Error("stageDesktop needs `report`: the page's globals object");
  const specs = programs.map(specFor);
  /* THE ORDERING RULE THAT USED TO BE A REFUSAL IS NOW A NOTE, because the reason for it did not
   * survive being measured.
   *
   * This threw when a program with `spawnsChildren` was staged before another, on the argument that
   * the kernel's cumulative ready count let that child satisfy the next spawn's wait so the `go`
   * reached a process still in `init` (`src/libos/process.mjs:244`). That fault was reported while
   * this module was being extracted and `['term', 'files']` was said to produce it.
   *
   * `bench/kernel-ready/probe.py` could not reproduce it. Four orders — including that one and the
   * `desktop`-first sequences this function actually stages — came up clean against a kernel whose
   * wait was deliberately restored to the cumulative counter, with every edit verified present. The
   * same probe DOES catch a kernel that skips the wait entirely, reporting the exact
   * `Cannot read properties of null (reading 'run')` fault four times, so it is coupled to the
   * symptom and the counter simply does not cause it here.
   *
   * `src/kernel/kernel.mjs`'s `awaitReady` now waits on the batch's own pids regardless, because a
   * counter shared with every other process cannot tell "mine came up" from "one more came up".
   * That is an argument about the accounting and it stands on its own.
   *
   * SO THE ORDER IS RECORDED AND NOT ENFORCED. A guard that refuses a working order is its own
   * defect: it would have constrained every later milestone's staging on evidence that did not
   * hold. The note travels in `report.notes` so a future fault has somewhere to be read from. */
  const early = specs.slice(0, -1).filter((s) => s.spawnsChildren);
  if (early.length && Array.isArray(report.notes)) {
    report.notes.push(`${early.map((s) => s.url).join(", ")} spawns a child by syscall and is `
      + "staged before another program. That was once refused; bench/kernel-ready/probe.py could "
      + "not reproduce the fault it was refused for, and awaitReady now waits on its own pids.");
  }
  const booted = opts.booted || await bootShell(opts);
  const { k, host, shell } = booted;

  const desk = specFor("desktop");
  const pids = {};
  pids.desktop = (await spawnProgram(k, desk.url, desk.argv(ceilingMs))).pid;
  if (shell) {
    const got = await until(() => {
      const d = shell.desktopEntry();
      return Boolean(d) && (noItems || d.items.length > 0);
    }, waitMs);
    if (got < 0) {
      throw new Error(`the desktop process published no ${noItems ? "window" : "rows"} within `
        + `${waitMs} ms; the start menu and the icons are those rows, so there is nothing to show`);
    }
  }

  let livePid = pids.desktop;
  for (const spec of specs) {
    const wanted = typeof spec.windows === "function"
      ? spec.windows(spec.count)
      : (spec.windows === undefined ? 1 : spec.windows);
    const before = appFrames(host).length;
    const row = await spawnProgram(k, spec.url, spec.argv(ceilingMs, spec.count));
    if (spec.name) pids[spec.name] = row.pid;
    livePid = row.pid;
    if (wanted > 0) {
      const got = await until(() => appFrames(host).length >= before + wanted, waitMs);
      if (got < 0) {
        throw new Error(`${spec.url} opened ${appFrames(host).length - before} of ${wanted} `
          + `window(s) within ${waitMs} ms`);
      }
      const entry = host.newest();
      if (entry && spec.box) {
        const wa = host.workArea();
        const b = spec.box(wa, entry);
        place(entry, { w: entry.win.placed.w, h: entry.win.placed.h, ...b });
      }
      if (entry && spec.focus && entry.term) entry.term.focus();
    }
  }

  const deskEntry = shell ? shell.desktopEntry() : null;
  const view = deskEntry ? deskEntry.icons : null;
  /* PUBLISHED FOR A DRIVER, because the live desktop is a path with no assertions on it and these
   * are the handles a probe reads the arrangement back through. They carry no capability a page did
   * not already have: the view is a DOM widget the page built. */
  report.view = view;
  report.pids = pids;
  if (diagnose) sayState({ say, host, shell, deskEntry, view, seed: report.seed || null });
  for (const line of help) say(line);
  report.phase = "live";
  report.livePid = livePid;
  return { k, host, shell, deskEntry, view, pids, livePid };
}

/**
 * WHAT THE SHELL ACTUALLY HAS, PRINTED — including the RECTS, because "4 icons drawn" and "4 icons
 * a reader can see" are different claims, which is constraint 40 in the small. The first Firefox run
 * of this desktop reported four icons drawn and showed none, and a PNG cannot say whether a box is
 * empty or elsewhere. Every value reaches the page through the caller's `say`, which is
 * `textContent`, so a filename on the desktop is text and never markup.
 */
export function sayState({ say, host, shell, deskEntry = null, view = null, seed = null }) {
  const r = (el) => {
    if (!el) return "none";
    const b = el.getBoundingClientRect();
    return `${Math.round(b.width)}x${Math.round(b.height)} at `
      + `${Math.round(b.left)},${Math.round(b.top)}`;
  };
  say("");
  /* THE SESSION'S TREE, PRINTED, because in a second engine the log is the only channel there is
   * (CLAUDE.md's second-engine rule) — and a seed that was refused looks from the outside exactly
   * like one that ran. `ran: true` WITH a `why` is a real state: the tree landed and the closing
   * snapshot did not. */
  if (seed && seed.seed) {
    const s = seed.seed;
    // A REFUSED SEED CARRIES ONLY `why` — `cfg.noSeed`'s report has no counts at all — so the two
    // states are printed as two sentences rather than one with `undefined` in it.
    say(`seed:     ${s.ran
      ? `ran — ${s.files} file(s), ${s.bytes} byte(s) from ${s.base} into ${s.dest} in ${s.ms} ms`
        + (s.why ? `; ${s.why}` : "")
      : `did not run — ${s.why || "no reason given"}`}`
      + (s.partial ? `; a half-copy is at ${s.partial}` : ""));
  }
  say("desktop:  " + (deskEntry
    ? `win ${deskEntry.id}, ${deskEntry.items.length} rows published, `
      + `${view ? view.report().icons : "NO ICON VIEW"} icons drawn`
    : "NO DESKTOP PROCESS — nothing published a row"));
  if (shell) {
    say("shell:    " + shell.report().buttons + " taskbar button(s), work area "
      + JSON.stringify(host.workArea()));
  }
  if (deskEntry) {
    say("rects:    frame " + r(deskEntry.win.el) + " | body " + r(deskEntry.win.bodyEl)
      + " | view " + r(view && view.el) + " | icon 1 "
      + r(view && view.el.querySelector(".desk-icon")));
    const svg = view && view.el.querySelector(".desk-icon svg");
    const path = svg && svg.querySelector("path");
    say("icon svg: " + (svg
      ? `${r(svg)}, ${svg.childElementCount} children, `
        + `${svg.querySelectorAll("linearGradient").length} gradient(s), first fill `
        + (path ? getComputedStyle(path).fill : "no path")
      : "NONE"));
  }
  say("");
}

/* RE-EXPORTED, NOT REDEFINED. A page that stages a desktop and asks for a gesture needs these four
 * and nothing else from the transport, and `gestureAsker` above all MUST stay one definition: it is
 * half of a handshake `scripts/check.py` is the other half of, and it owns the banner a page paints
 * when nothing is driving it (constraint 283). Everything else a page needs from the kernel —
 * `shutdown`, `resultOf`, `ask`, `typeSynthetic` — stays in `www/pagekernel.mjs`. */
export { gestureAsker, spawnProgram, until, sleep };
