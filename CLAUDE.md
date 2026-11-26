# CLAUDE.md

Guidance for working in this repository. My global rules in `~/.claude/rules/` still apply —
this file adds only what is specific to web-os, and does not restate them.

## What this is

A browser-hosted operating system: Windows 7 surface, Linux-shaped runtime. Processes with pids,
a syscall ABI, a POSIX-ish VFS, a real shell.

**The one invariant.** A process reaches the system only through the syscall channel. Not by
convention — by construction. The predecessor (`../webxp`) failed because apps were ES modules
that imported the filesystem directly and each app *was* its window, so nothing was isolated,
killable or backgroundable. Every change here is measured against whether it preserves the
boundary.

## Onboarding

Read in this order. The whole set is about 90 minutes; the first four are about 25 and are enough
to start work.

| # | File | Read it for | Size |
| --- | --- | --- | --- |
| 1 | `CONTEXT.md` | What a kernel, process and syscall *are*; why a browser makes this hard; what the other web OSes do; what the predecessor got wrong. **Start here even if you know Unix** — §2 and §4 are project-specific. | 5 min |
| 2 | `docs/CONSTRAINTS.md` | 305 numbered constraints. **Normative.** Cite by number in code comments and commit messages. | 10 min |
| 3 | `docs/ABI.md` | The 71-call syscall table, the SAB layout, errno space, fd inheritance, and the five decisions that carry the design. | 7 min |
| 4 | `MILESTONES.md` | What is done, what is next, the proof and negative control each milestone owes. | 5 min |
| 5 | `docs/DECISIONS.md` | 34 decisions, what each rejected, and whether it rests on a measurement or a judgement. **Read before arguing with any of them.** | 12 min |
| 6 | `PLAN.md` | Why the order is the order; options A/B/C; §9 what critics changed; §10 what is still unknown. | 15 min |
| 7 | `docs/designs/REVIEW-FINDINGS.md` | 24 verified critiques. Several are traps already walked into once. | 15 min |
| 7b | `docs/LEARNING-MODE.md` | Option D: the learning mode and the teaching CPU. Read §2 (where the honesty line sits) before writing any view. | 12 min |
| 8 | `docs/GLOSSARY.md` | Lookup, not prose. Use it as you go. | — |

Then as needed: `docs/research/gap-04.md` for the measurements everything is sized from,
`docs/research/gap-03.md` for how the ABI was derived, `docs/research/gap-07-fork.md` for why
`fork` is unavailable and why the first answer to that question was wrong, `docs/designs/*.md` for the four long-form
candidate architectures, `docs/research/01-07` for the reference-system teardowns.

### You are oriented when you can answer these without looking

1. Why must the kernel be a dedicated Worker rather than the main thread? (Two reasons: one is a
   thrown exception, one is a measured latency.)
2. What does a process actually hold, and why nothing else?
3. Why is there no `fork`, and what exactly does a shell lose?
4. What makes per-app-origin isolation and a blocking syscall channel mutually exclusive?
5. What does M6 close, and why is calling it "security" wrong?
6. Why is the OPFS blob directory flat and named by inode?
7. Why can't an Aero glass check use a flat backdrop?
8. M0 was the one milestone that could invalidate the whole plan. What did it measure, what did it
   accept on, and what did it change about the plan? (Three things it changed are in
   `MILESTONES.md` §M0; one of them makes the process table's cap advisory.)

If any answer is not available to you, the file that carries it is in the table above. If an answer
in the repo seems wrong, see §When a constraint looks wrong — do not route around it.

### What is where

```
CONTEXT.md        background: OS concepts, browser limits, the other web OSes, webxp
PLAN.md           the three options, the schedule, what critics changed, open gaps
MILESTONES.md     tracker: status, proofs, negative controls, open experiments
CLAUDE.md         this file: working rules for the codebase
README.md         orientation and the one-command start
docs/
  CONSTRAINTS.md  305 normative constraints  ← cite these
  ABI.md          the syscall table
  DECISIONS.md    decision log with evidence class per decision
  GLOSSARY.md     terms
  LEARNING-MODE.md  option D: learning mode, the teaching CPU, device providers
  designs/        4 candidate architectures + REVIEW-FINDINGS.md
  research/       507 cited claims. Raw evidence, append-only.
scripts/
  serve.py        COOP/COEP static server. --no-isolation to prove a check fails.
  cdp.py          Chrome DevTools Protocol driver, carried from webxp
  check.py        the harness: one registry, --prove-failure, the negative controls
  check_floors.json  committed min_expectations ratchet. Lowering a floor is a reviewable diff.
bench/
  coep-tiles/     worked example of the harness discipline, with a working negative control
  syscall-contention/  M0's bench: the saturation sweep and its eight controls
  feasibility/    option D feasibility: RV32I MIPS, Proxy-MMU cost, trace-ring cost
  m16-resize/     M16's half-day probe, run BEFORE its code: is a resize grip drivable over CDP,
                  can the suite be driven at a chosen dpr, and does a backing store follow its
                  client box. It also answered M17's first question as a side-effect
  m17-wheel/      M17's probes. `probe.py` measured the WHEEL'S UNIT (constraint 297) and that the
                  transport does not coalesce (298); `probe.mjs` asserts the clip RESET under node;
                  `firefox-scroll.py` scrolls the list in a SECOND ENGINE with trusted input
  m18-keys/       M18's gates. `clickcount.py` measured WHICH EVENT CARRIES THE CLICK COUNT in both
                  engines — `pointerdown.detail` 0, `mousedown.detail` 1 then 2 (constraint 300) —
                  and `firefox-keys.py` opens a row and walks a list with REAL keys in Firefox,
                  with a `--prove-failure` half that substitutes `j` for the Down arrow
  m19-advance/    M19's advance-table measurement, run BEFORE the table was published. Replays a
                  real DL_TEXT op through `src/wm/surface.mjs`'s OWN Surface and measures in the
                  context the renderer left, so the font string is nowhere in the measurement path.
                  Two engines x three ratios x 17 sizes; `table-headless.json` IS the candidate
                  table and `results-headless.json` the verdict (constraints 302, 303)
  m19-hover/      M19's hover measurement — the one constraint 223's reversal rests on. 500 driven
                  moves into a held program in three worlds, each served from its own patched COPY
                  of the tree, plus `firefox-hover.py` with REAL trusted input. STALE AS A RIG now
                  that the kernel coalesces by default; the numbers stand, the re-run misleads
  m19-host/       `drive.py`: the page's half alone — a hover delivered, a hover that is not a drag,
                  a leave, a rendered cursor and a refused one. Six clauses, `--prove-failure`
  m19-page/       `firefox-m19.py`: www/m19.html in Firefox, through the page's own `M19.listState`
                  and `M19.aimAt` — so a second engine grows no display-list reader of its own
  m19-details/    `firefox-details.py`: the sort, the range select and the hover on the LANDING
                  page in Firefox with real trusted input. Two controls, each naming its own
                  subset, and `--prove-failure`
mockups/
  milestones.html   what is on screen at each milestone (M0-M14, D0-D8)
  learning-mode.html the three learning-page types + the coverage matrix
  shoot.py          renders both and fails on a JS error
src/
  abi.mjs         every integer both sides agree on, and nothing else   ← see below
  fs/             the filesystem codecs, the mount table and the byte ring: PURE  ← see below
  kernel/         the only privileged code
    pipe.mjs      the pipe: a kernel-side buffer, and the EOF/EPIPE asymmetry
    pty.mjs       the pty and the line discipline. Ctrl-C lives here, not in the terminal app
    synth.mjs     ONE adapter for every generated filesystem; a new one is two functions
    procfs.mjs    /proc, regenerated per read from the live process table — never cached
    devfs.mjs     /dev, and the one renderer /dev/trace and the page both read
    trace.mjs     the syscall trace ring. Reads no clock; see constraint 72
    providers.mjs the provider table as DATA, and the only place a request URL is built
    advance.mjs   M19: the measured glyph advances, as DATA and never as a measuring capability.
                  One frozen table and the string /dev/advance serves, built once at load
    providerfs.mjs  /usr, mounted atomically over a provider or refused loudly
    wins.mjs      M7: a window IS a file description. The event ring, the owner chain, the
                  destroy cascade, the not-responding detector. It replaced M4a's console.
                  M12's blur governor is here too: `governBlur` is an admission controller
                  over blurred area, degrading by z-order from the bottom
    dataobj.mjs   M10: the typed data object, the ONE clipboard slot and the ONE drag session.
                  Refcounted payloads a process reaches by fd, so teardown releases them
  libos/          in-process syscall stubs + realm lockdown — the trust boundary
    lockdown.mjs  M6: what a program's realm loses, as data. Fails CLOSED and says why
  bin/            the programs in /usr/bin, one file each. `true.mjs` states the program contract
  share/          the data files `/usr/share` mounts: a PNG nothing here decodes, the same
                  image as a DOBJ_BITMAP payload, and a text file. M10's proofs need real bytes
  wm/             userland window manager
    window.mjs    the frame: geometry, clamp, drag, arrow keys — and M11's FOUR glass strips.
                  M14's eight resize grips, Aero Snap's three thresholds and `boxForState` are
                  here too: what a docked state MEANS as geometry, in one place, so the snap
                  ghost cannot promise a rectangle the window will not take
                  It builds the structure and names nothing about how it looks, which is what
                  lets M7-M10's checks drive an unskinned frame
    aero.mjs      M11: every number Windows 7's glass is made of, once, and the stylesheet
                  derived from them. The METRICS and the area function live in `src/abi.mjs`
                  (M12, D37) because the kernel's governor accounts them too; this file
                  imports and re-exports them under the names its CSS uses
    terminal.mjs  the terminal widget. IT DOES NOT ECHO — constraint 161
    winhost.mjs   the page's half of EVERY window: one frame per kernel window, and the one
                  route from a browser event into a window's event queue
    surface.mjs   M8: the ONE renderer of a display list. A canvas per surfaced window, and
                  the only place a drawing op becomes a drawing call. `clientAt` is the declared
                  inverse of `pointAt`, which is what lets a driver drag from inside a picture
    taskbar.mjs   M14: the Superbar, the start menu, a jump list, the tray and the window menu.
                  Page-side chrome (D39) whose CONTENTS are a process's — it renders rows it was
                  published and decides nothing about what they are
    desktop.mjs   M14: the icon view. Selection, the rubber band, both context menus, and the
                  GRID — `#cellAt` is the declared inverse of `#boxFor`, which is what lets a
                  dropped icon land where the auto-layout would have put it (constraint 284).
                  The arrangement holds a CELL, so a resize re-lays it out
    icons.mjs     M14: one vector drawing per `WICON_*`, with `selfTest` asserting the ABI's
                  table is covered
www/
  index.html      THE LANDING PAGE: the boot preflight, which still refuses to proceed and says
                  which capability is missing, AND THEN THE DESKTOP. It carries NO proofs and
                  reads no query string, so the bare URL is the product (constraint 283) and
                  there is no mode to select. `scripts/check.py --only landing` is its gate
  m0.html         the syscall-channel bench page
  m4a.html        the window and the terminal. The one page a check types REAL keys into
  m6.html         the realm, the volume, the loader and the fault. M6's five proofs
  m7.html         M7's six proofs, and then a LIVE DESKTOP: a shell you can type into, and
                  `winopen` for as many more windows as you want. `?live=1` skips the proofs
  m8.html         M8's four proofs — a pattern read back out of the canvas, a REAL mouse drag,
                  the surface budget, the content mode — and then a desktop where `paint` is a
                  window you draw in with the mouse
  m9.html         M9's four proofs — the owner chain, a refused raise, input suppression, the
                  close request — and then a desktop where `editor` will not close without
                  asking
  m10.html        M10's four proofs — an image through the clipboard with its source KILLED, a
                  REAL mouse dragging a file row between two processes, a typed refusal, and the
                  budget — then a desktop with `files`, `imgview` and `clip`
  m11.html        M11's six proofs — the ring against its own formula, the unsevered blur chain,
                  the glass blurring across a HARD BLACK/WHITE SEAM, the caption legible on both
                  sides of it, the inert caption buttons, the active/inactive pair — then a LIVE
                  AERO DESKTOP. The pixels are read by `scripts/check.py` out of a screenshot,
                  because a `backdrop-filter` is unreachable from script
  m12.html        M12's four proofs — the accounting against the RENDERED strips, the degrade
                  from the bottom of the stack, both edges of the hysteresis, and a flattened
                  caption reading as a STEP where a glass one is a ramp — then a live desktop
                  with the governor armed at four windows, so `winopen -n 4` degrades it
  m13.html        M13's seven proofs: the geometry driven with REAL input — drag, resize, the
                  arrow keys, the clamp at both extremes, and a relayout when the viewport
                  changes under a window that was already placed
  m14.html        THE WINDOWS 7 DESKTOP, and it is what you get at the bare URL. Aero Snap, the
                  Superbar with grouped buttons and hover previews, jump lists, the start menu,
                  the tray, and a desktop of icons that snap to a grid. `?proofs=1` is the
                  HARNESS — nine proofs that stage their own windows and block for a driver, so
                  it is the harness's to open and not a reader's (constraint 283)
  m16.html        M16's seven clauses at four frame sizes and BOTH ratios — dpr 2 and dpr 1 —
                  because the defect it removes is ratio-shaped and INVISIBLE at dpr 1, where a
                  CSS-px box handed to `win_surface` is numerically right. The first page in this
                  project to drive a real RESIZE GRIP
  m17.html        M17's eleven clauses: a driven WHEEL over a 40-entry directory, the clip that
                  stops a scrolled row painting over the header (read as a PIXEL), both clamp
                  edges, and the coalescing — a 300-notch stream into a program held in its
                  declared `--no-drain` mode, scored on `queued:`/`coalesced:`/`dropped:`. The
                  bare URL is a live desktop you can scroll; `?proofs=1` is the harness
  m18.html        M18's 27 clauses over three driven proofs: a DOUBLE-CLICK that re-lists a window
                  and one that spawns the program the association names, a driven Down arrow moving
                  a cursor and Enter opening THE ROW THE ARROW REACHED, and Back over two
                  mechanisms — Alt+Left as a keysym with a modifier, Backspace as a byte. It takes
                  NO control flag deliberately: all three of its worlds live in files it does not
                  own, so they are `repo_fixture` patches and a clause asserts the page reads only
                  `proofs`. `diagnose` names the ONE fact behind several red clauses, with the
                  address
  m19.html        M19's 49 clauses over FIVE driven proofs: a header click that sorts and a second
                  that reverses, a folder with a Date cell and no Size cell, a buttonless move that
                  lights a row and a leave that clears it, an anchor-based range select, and a
                  rubber band that selects by intersection while a press on a ROW starts a drag.
                  It asks for EXACTLY 56 gestures, 41 of them the hover stream. `M19.listState` and
                  `M19.aimAt` are its own decoder and its own aim, published so a driver in another
                  engine grows neither
  pagekernel.mjs  the page's half of a kernel, as a module: boot (with one retry), shut down,
                  spawn a program by URL, collect its result, and the GESTURE PROTOCOL — the ask,
                  the receipt, and the banner a page paints when nothing is driving it. m7, m8,
                  m11, m13 and m14 import it; the older pages still carry their own copies
  shell.mjs       the ONE DEFINITION of staging the desktop shell, a layer above `pagekernel.mjs`:
                  `PROGRAMS` and `DESKTOP_HELP` as frozen DATA a milestone adds to, `stageDesktop`
                  as the order a desktop is assembled in, and `requireIsolation` as the abort gate
                  nineteen proof pages still paste. index, m14, m17, m18 and m19 import it; it re-exports
                  `gestureAsker`/`spawnProgram`/`until`/`sleep` rather than redefining them,
                  because a second banner is a second handshake for `scripts/check.py` to agree
                  with by hand
```

**`src/abi.mjs` sits outside the three-directory layout deliberately.** A syscall number, errno or
SAB offset must have exactly one definition imported on both sides, and the kernel and a process
are precisely the two sides — so the file can belong to neither. It holds integers and pure codecs,
performs no I/O and closes over no capability, which is why a process may import it. Do not move it
under `kernel/` (a process must not import kernel code) and do not give it behaviour.

**`src/fs/` is pure for a reason that is a standing constraint, not a style.** The journal replay
path is a parser over possibly-torn bytes, which is a fuzz target — and it is only a fuzz target
while it runs in plain Node in milliseconds. `scripts/fsfuzz.py` runs 10,000 torn journals in about
three seconds because nothing in `src/fs/` touches OPFS, a SAB or a Worker. **A codec that reaches
for storage inside its parse path breaks that gate**, which is the intended alarm: the alternative
is M2a decaying into a second implementation maintained beside the real one. All I/O lives at the
edges, in `src/kernel/`.

The predecessor is a sibling checkout at `../webxp`, and also
<https://github.com/nchafy/webxp>. Several milestones port code from it. **If `../webxp` is not
present**, clone it beside this repo — the paths in `MILESTONES.md` assume it. Nothing in this
repo *depends* on it at runtime.

`docs/research/` is **append-only**: it records what was found when. If a finding turns out wrong,
correct `docs/CONSTRAINTS.md` and note the correction there; do not quietly edit the research to
match. `docs/DECISIONS.md` §Corrections already carries two such cases.

## Single sources of truth

One fact, one definition. A second copy is how the two drift, so a new call site MUST import the
row below rather than restate it.

| Fact | Its one definition |
| --- | --- |
| Syscall numbers, errnos, SAB offsets, flag bits | `src/abi.mjs` — imported by the kernel and by a process, which are the only two sides |
| The `filestat` record | `FST_*` + `encodeFilestat`/`decodeFilestat` in `src/abi.mjs` |
| The `statfs` record | `SFS_*` + `encodeStatfs`/`decodeStatfs` in `src/abi.mjs` |
| The `dirent` record and its 4-byte padding | `DE_*` + `direntSize` in `src/abi.mjs` |
| The `termios`, `winsize` and `pollfd` records | `TRM_*`, `WS_*`, `PFD_*` + their codecs in `src/abi.mjs` |
| The longest component a name may be | `NAME_MAX` in `src/abi.mjs`. Every `statfs` implementation publishes it; none restates 255 |
| The largest inline payload | `MAX_INLINE` in `src/abi.mjs`. Program read buffers are sized from it, never from 65536 |
| The trace render limit | `TRACE_RENDER_LIMIT` in `src/kernel/devfs.mjs`. `/dev/trace` and the page's `trace-read` are one renderer, so they are one limit |
| A window's event queue and its record | `WIN_EVENT_CAP` and `WEV_*` + `encodeWinEvent`/`decodeWinEvent`/`keyBytesOf`/`packKeyBytes` in `src/abi.mjs`. The kernel writes the record and the libos reads it, which is the two sides |
| A text run in a display list | `DL_TEXT` + `DL_TEXT_DATA`, `DLT_*` and `encodeTextRun`/`textOfOps`/`textOpCount` in `src/abi.mjs`. A header plus continuation records, because a record is 32 bytes and a string is not; the two functions are declared inverses and the selfTest asserts the round trip. The kernel validates a run with the SAME codec the renderer draws it with (constraint 293) |
| `src/bin/files.mjs`'s row geometry | `FILES_METRICS` in that file, exported. `rowMid` is what a driver outside the process reads — `www/m10.html` and `bench/m10-data/shell.py` both restated it until M15 moved the rows and the drift arrived exactly as CLAUDE.md predicted (the wrong file dragged). **M19 added `FOOT_H`**, a new term in `viewBox`/`scrollMax`/`rowsThatFit`/`clientHeightFor` — a driver that ASKS here follows it and one that restated a formula does not |
| The DETAILS view's columns, in both directions | `COLUMNS` (frozen data) + `columnBoxes(wCss)` and `columnAt(xCss, wCss)` on `FILES_METRICS`, in `src/bin/files.mjs`. `columnAt` is the declared inverse of `columnBoxes`, which is what makes a header press sort the column a reader is pointing at — the same pairing `#cellAt`/`#boxFor` make on the desktop. The hit test and the drawing read ONE geometry, so they cannot disagree about which column a pixel is in. `dateText`/`sizeText` are the two cell formatters and `UNKNOWN_CELL` the mark for a statted row with a zero stamp |
| A display-list op, and how many fit in a call | `DLOP_BYTES`, `DL_*` + `encodeDrawOp`/`decodeDrawOps` and `DL_MAX_OPS` in `src/abi.mjs`. `DL_MAX_OPS` is DERIVED from `MAX_INLINE`, never written |
| What `0xRRGGBBAA` means | `unpackColor` in `src/abi.mjs`, with `cssColor` for a canvas and `pixelColor` for a pixel read back. The two APIs disagree about alpha and a second copy gets one of them wrong (constraint 224) |
| The surface budget | `SURFACE_BUDGET_PX` and `SURFACE_MAX_PX` in `src/abi.mjs`; the accounting is `WinMgr.surface`/`releaseSurface` in `src/kernel/wins.mjs` and nowhere else |
| The z-order, and who may be raised over whom | `WinMgr.stack` and `blockingFor` in `src/kernel/wins.mjs`. The page renders the order it is sent and decides nothing (constraint 226) |
| What a modality means | `WMODAL_*` (scope) and `WMODE_*` (behaviour) in `src/abi.mjs`. Two axes, and a design with one cannot tell a tooltip from a save dialog |
| Which bindings a process realm loses | `TARGETS` in `src/libos/lockdown.mjs`. A check enumerates it; `bench/m6-realm/program.mjs` MUST import it rather than list the names again |
| The takers of the per-inode lock | the `withInode` docstring in `src/kernel/store.mjs`. `scripts/fsfuzz.py`'s `INODE_TAKERS` mirrors that list and lints against it |
| Where a provider request URL is built | `urlFor` in `src/kernel/providers.mjs`, and nowhere else |
| The provider table | `PROVIDERS` in `src/kernel/providers.mjs`, as data |
| What each check asserts, and its negative control | the check's own registration in `scripts/check.py`. Inversion is a per-check `Control.INVERT`, never a tuple maintained beside the checks |
| The expectation floors | `scripts/check_floors.json`. Lowering one is a reviewable diff |
| Every number Aero's glass is made of | `src/wm/aero.mjs` — the three balances, the colorization colour, the blur deviation, the caption and inset metrics, and the stylesheet DERIVED from them. Generated rather than written as a `.css` file because `CAP_H` and `INSET` are the terms of `ringArea`, and there is no build step |
| A frame's FILTERED area, and the chrome it is made of | `WIN_CAP_H`, `WIN_INSET` and `blurRingArea`/`blurBoxArea` in `src/abi.mjs`. They MOVED there in M12 (**D37**) for the reason everything in that file is there: constraint 49 makes the kernel account the border box, so the ring's geometry stopped being the skin's private business. `src/wm/aero.mjs` imports them and re-exports `CAP_H`/`INSET`/`ringArea` under the names its stylesheet uses. A second copy is how a governor comes to account a frame nobody renders, which is constraint 49's ~17× under-read |
| The blur budget, and who is flat | `BLUR_OFF_AT`/`BLUR_ON_AT` in `src/abi.mjs` (two edges, because a threshold on a continuous input needs hysteresis); the accounting and the degrade order are `WinMgr.governBlur` in `src/kernel/wins.mjs` and nowhere else. The page renders the flat set it is sent and decides nothing (constraint 226's rule again) |
| How a glass seam is sampled, and what separates a ramp from a step | `band_profile`, `transition` and `local_range` in `scripts/png.py`. `scripts/check.py` asserts with them and `bench/m11-glass/probe.py` chose the threshold with them, so the gate and the measurement behind it are ONE arithmetic |
| A data format, its offer bit and its name | `DOBJ_*` + `fmtBit`/`fmtsOf`/`fmtName` and `DOBJ_FORMATS`/`DOBJ_FMT_ALL` in `src/abi.mjs`. The offer is a BITMASK in one register, so the packing has one definition and three readers: the kernel builds it, an event record carries it, a target tests it |
| The `DOBJ_BITMAP` payload's header | `BMP_*` + `encodeBitmap`/`decodeBitmap` in `src/abi.mjs`. `8 + w*h*4` written a second time is the drift this exists to stop |
| A PATH'S EXTENSION | `extOf` in `src/libos/std.mjs`. It existed FOUR times — inside `formatForPath`, inside `iconForPath`, and as `desktop.mjs`'s own `extOf` — each spelling the same split, so the rule that `.profile` is a name and not a file of type `profile` was decided four times. Every table keyed by extension asks this one function |
| Which format a file's bytes are | `FORMAT_BY_EXT` + `formatForPath` in `src/libos/std.mjs`. A USERLAND convention — the kernel knows no names — and three programs need it, so a second copy is how `clip` and `files` come to disagree about a `.rgba` |
| Which program opens a FILE, and with what argv | `OPENS_FILES` + `openerForPath` in `src/libos/std.mjs`, beside `FORMAT_BY_EXT` and `ICON_BY_EXT` and userland's for their reason. It MOVED there from `src/bin/desktop.mjs` when M18 gave `files` an activation verb — the second reader is what justified the move, and a copy in `files` is how a `.rgba` comes to open in one program from the desktop and another from the file list. **The argv is part of the association**, not a caller's business: `imgview` wants `-f PATH` and `editor` a bare path. `null` and never a default, because launching an arbitrary program on unknown bytes is how a reader is shown a binary as text |
| A data object's lifetime, the clipboard slot and the drag session | `src/kernel/dataobj.mjs`, and nowhere else. `WinMgr.pointer` is the one record of whether a button is down, because `feed` is the one place a pointer event enters the kernel |
| Where a drop landed, in a window's own unit | `WinHost.#dropPointAt` in `src/wm/winhost.mjs`: surface pixels for a surfaced window, CELLS for a text one — the two units `WEV_POINTER` and `WEV_RESIZE` already use |
| A window's SHOW STATE and ROLE, and what a published row is | `WST_*`, `WROLE_*`, `WITEM_*`, `WICON_*` + `encodeWinItems`/`decodeWinItems`/`winItemSize` in `src/abi.mjs`. The kernel validates a row's index and the shell draws its label, which is the two sides |
| Aero Snap's three thresholds | `SNAP_ARM_PX`, `SNAP_RELEASE_PX` and `MAX_RELEASE_PX` in `src/wm/window.mjs`, read by `releaseDistance` and nowhere else. The arm and the release are a hysteresis PAIR (constraint 273) |
| What a docked state means as geometry | `Win.boxForState` in `src/wm/window.mjs`. The snap ghost and the layout both read it, so a preview cannot promise a rectangle the window will not take |
| The WORK AREA, and the strip the shell reserved | `WinHost.reserve`/`workArea` in `src/wm/winhost.mjs`. Reserving re-clamps every existing frame, because a maximized window laid out before the taskbar appeared is laid out against a desktop that is gone |
| The shell's own metrics | `TASKBAR_H`, `TASK_BTN_*`, `ORB`, `ICON_PX`, `ICON_CELL_*`, `THUMB_*` in `src/wm/aero.mjs`, with the stylesheet derived from them — `TASKBAR_H` is not a look, it is the strip `reserve` subtracts |
| The desktop's icon GRID, in both directions | `#grid`, `#slotCell`, `#boxFor` and `#cellAt` in `src/wm/desktop.mjs`. `#cellAt` is the declared inverse of `#boxFor`, which is what lets a dropped icon land exactly where the auto-layout would have put it; `#freeCell` is the only place a collision is resolved. The arrangement holds a CELL and not a pixel, so a resize re-lays it out (constraint 284) |
| A preview panel's width, and how many thumbnails fit a row | `THUMB_W`, `THUMB_H` and `THUMBS_PER_ROW` in `src/wm/aero.mjs`, with the panel's `max-width` DERIVED from them. A menu's 320 px cap applied to a 208 px thumbnail is how the second one came to render outside the glass (constraint 285) |
| An icon's drawing | `src/wm/icons.mjs`, one function per `WICON_*`, with `selfTest` asserting the ABI's table is covered. Gradient ids are per-document, because two icons of one kind in one document would otherwise share them |
| Which icon a FILE gets, and which a PROGRAM's button gets | `iconForPath` in `src/libos/std.mjs` (userland's convention, beside `formatForPath`) and `ICON_BY_PROG` in `src/wm/taskbar.mjs` (the shell's, for a window that publishes no icon of its own) |
| Where a window opens when its program has no opinion | `WIN_ORIGIN_X`/`WIN_ORIGIN_Y` in `src/libos/std.mjs` — userland's convention, beside `iconForPath`, because the kernel knows nothing about icons. It is NOT the top-left corner: that is the desktop's icon column, and a window there makes the desktop stop working (constraint 289). The kernel spreads what comes after, by stepping an exact corner collision down-right (`WinMgr.#cascade`, constraint 291) |
| Which programs open a window of their own | `OPENS_OWN_WINDOW` in `src/bin/desktop.mjs`. An ALLOWLIST: everything else in `/usr/bin` writes to stdout, so a menu row runs it inside a terminal rather than spawning a process with nothing to show (constraint 290) |
| A whole file's bytes by path | `readFileBytes` in `src/libos/std.mjs`. `src/bin/clip.mjs` had its own copy until M14 needed the same three lines for `imgview -f` |
| A window's CLIENT BOX and the ratio that relates it to CSS px | `WEV_CLIENT` + `clientBoxAt`/`dprFixed` and `DPR_FIXED_ONE` in `src/abi.mjs`. The box is DEVICE px — the unit `win_surface` takes and `SURFACE_MAX_PX` bounds — and the ratio RIDES THE RECORD because a process has no other route to it. A program's own layout constants are CSS px, and this is what converts them |
| A WHEEL's deltas and the point it was aimed at | `WEV_WHEEL` + `wheelAt`/`packWheelPoint` and `WWHEEL_PAGE`/`WWHEEL_COALESCED` in `src/abi.mjs`. Surface px for a surfaced window, CELLS for a text one (constraint 248) — never device px. `packWheelPoint` is `wheelAt`'s declared inverse, because x and y share one 32-bit word |
| The `mods` bit namespace, as ONE table | `selfTest` in `src/abi.mjs`, derived from `INTS` by the prefixes `WPTR_`/`WMOD_`/`WWHEEL_`. It was three separate clauses — pointer bits against each other, modifiers against each other, pointer against modifier — so a THIRD sub-table could collide with either, unseen. M17's wheel bits were the third one, and M18's `WMOD_META`/`WPTR_CLICK2`/`WPTR_CLICK3` are why it has to stay derived |
| A KEY THAT IS NOT BYTES | `WKEY_*` (dense 1..`WKEY_MAX`) + `keysymOf` in `src/abi.mjs`, and `KEYSYM_BY_KEY`/`keysymForKey` in `src/wm/winhost.mjs` — the ABI's table and the ONE browser-key mapping onto it, which is `event.key` and never `code`, because `code` is a physical position and would make an AZERTY keyboard send the wrong keysym. `a == 0` is the discriminator and `keysymOf` is the one place it is read, as `keyBytesOf` is the one place the bytes are unpacked: the two are disjoint and exhaustive, asserted BOTH ways in `selfTest` (constraint 299). **Enter, Tab and Backspace are BYTES** — `bytesForKey` in `src/wm/terminal.mjs` spells them 10, 9 and 127, and a keysym row for any of them would take the key away from every program reading them today |
| A CLICK COUNT | `WPTR_CLICK2`/`WPTR_CLICK3` in `src/abi.mjs`, set by `clickBits` in `src/wm/winhost.mjs` and nowhere else, on the DOWN record only — `event.detail` is meaningful on the UP of a double-click too, and a program reading both opens a row twice for one gesture. The count is the PLATFORM's and never a timer's, so it MUST be read off the event that carries it: `pointerdown.detail` is 0 in both engines and only `mousedown` has it (`bench/m18-keys/clickcount.py`, constraint 300) |
| The CLIP, and who resets it | `DL_CLIP` + `DLC_RESET` in `src/abi.mjs`, applied in `Surface.replay` in `src/wm/surface.mjs` — which MUST reset at the top of every batch, because a canvas clip only ever intersects. A clip left set by batch N makes batch N+1 draw nothing: a window blank on its next repaint with no error anywhere. `bench/m17-wheel/probe.mjs` is what proves the reset exists |
| A LEAVE, and the test that must not swallow it | `WPTR_LEAVE` in `src/abi.mjs`, sent as `mods` EXACTLY that bit by `src/wm/winhost.mjs` and merged by `Window.pushPointer` in `src/kernel/wins.mjs` on FULL `mods` equality. A masked test lets a following hover swallow the leave and a program keeps a lit row for a pointer that has gone (constraint 304). `a`/`b` are not a position on a leave — the event fires outside the surface |
| Whether a buttonless move coalesces, and the degrade it prevents | `Window.pushPointer` in `src/kernel/wins.mjs` and nowhere else; `setHoverCoalesce(on)` is the one lever that turns it off. A merge returns WITHOUT calling `push`, so `queued` counts records that ENTERED the ring and `coalesced` the offers that did not — the division M17's wheel already made. 500 appended moves into a held program drop 247; tail-replaced they drop 0 (`bench/m19-hover/`, constraint 223) |
| A CURSOR a process asks for | `WIN_SET_CURSOR` + `WCUR_*` (dense 0..`WCUR_MAX`) and `WCUR_CSS` in `src/abi.mjs`; the accounting is `WinMgr.setCursor` in `src/kernel/wins.mjs` and the rendering is `WinHost.#cursor` in `src/wm/winhost.mjs`, which MUST index `WCUR_CSS[v]` and never write a keyword of its own. A NUMBER and not a string, because `cursor` takes `url(...)` and a `url(...)` is a fetch (constraint 305). There is deliberately no `wait` |
| The GLYPH ADVANCES, and the set of sizes they are priced at | `src/kernel/advance.mjs` holds the measured table and builds the string `/dev/advance` serves; `TEXT_SIZES`, `ADVANCE_PATH`, `encodeAdvances`/`decodeAdvances`, `advanceWidth`, `advanceKey` and `ADV_CP_MIN`/`ADV_CP_MAX` are in `src/abi.mjs`. The sizes are SURFACE px — the unit `DL_TEXT`'s `a2` carries — and DERIVED from the CSS sizes programs draw at, half-UP as `Math.round` is. A size outside the set has NO ROW on purpose (constraints 302, 303). These sit beside `TEXT_SIZES` and not in `INTS`, so the device's own header is the stale-copy gate rather than `ABI_FINGERPRINT` |
| The two font stacks | `UI_FAMILY`/`MONO_FAMILY` in `src/abi.mjs`. The renderer and the advance table MUST agree about them or the table prices a font nothing draws — which is why `bench/m19-advance/probe.py` reads the pair out of `src/wm/surface.mjs` by regex and fails loudly if either stops being a quoted const. **`src/wm/surface.mjs:26-27` and `src/wm/taskbar.mjs:95` still carry copies**; that is the import this row is waiting for |
| How a desktop shell is STAGED, and what is on it | `www/shell.mjs` — `PROGRAMS` (url, argv, window count, placement, per program) and `DESKTOP_HELP` are the DATA a milestone adds a row or a line to; `stageDesktop` is the order. `www/index.html` and every milestone page's live mode import it. It was `www/m14.html`'s `bootHost()`/`live()` with a copy on each other page, which is exactly how "the landing page is always up to date with the latest features" became a promise kept by hand: a program that landed in one page's copy was absent from the rest and nothing said so. It also enforces one ordering rule a copy cannot — `term` spawns `sh` by syscall, so a `spawnsChildren` program MUST be last in `programs`, and a bad list throws before the kernel boots |
| The 305 normative constraints | `docs/CONSTRAINTS.md`. Code cites by number and does not restate the argument |

**Known second copies, not yet removed.** Each is a row this table cannot honestly claim yet:
`modeString` exists in both `src/fs/vfs.mjs` and `src/bin/ls.mjs`; `joinPath` in both
`src/fs/vfs.mjs` and `src/bin/ls.mjs`; the `crossOriginIsolated` abort gate and `out`/`say` are
pasted into nine `www/*.html` pages; `class Serving` and `chrome_full_version` are duplicated
between `bench/fs-core/probe.py` and `bench/syscall-contention/probe.py`; and four files hand-roll
the CDP connect sequence that `scripts/cdp.py` already provides. **One row left this list in M14**:
`src/bin/clip.mjs`'s own open-slurp-close loop became `std.readFileBytes` when `imgview -f` needed
the same three lines. **TWO MORE LEFT IT IN M15, and the second one left by arriving**:
`src/bin/files.mjs`'s row geometry was restated in `www/m10.html` and `bench/m10-data/shell.py`
with a note saying a drift "arrives as the WRONG FILE being dragged" — then M15 moved the rows, so
both read `FILES_METRICS` now. The bench script's excuse was that it is outside the process and
cannot import the module; that was true of the PROCESS and false of the page it drives.
`docs/designs/REVIEW-CODE-2026-11.md` carries the addresses.
**The desktop-staging copy left it with the landing page**, and the isolation gate now HAS a one
definition it did not have: `requireIsolation`/`isolationFailure` in `www/shell.mjs`.
`grep -ln crossOriginIsolated www/*.html` now names **22** files and only `www/index.html` reaches
it through that function, so the row above is understated rather than closed — the remaining
twenty-one are proof pages, and M18 and M19 each added one more rather than retiring any.
**ONE MORE LEFT IT IN M18, AND IT WAS FOUR COPIES RATHER THAN TWO**: the extension split lived
inside `formatForPath`, inside `iconForPath` and as `src/bin/desktop.mjs`'s own `extOf`, each
spelling the same `lastIndexOf(".")` rule. It is `std.extOf` now, and the file-association table
went with it — `OPENS_FILES` moved from `src/bin/desktop.mjs` to `src/libos/std.mjs` because
`files` became its second reader, which is the rule for when an abstraction is earned rather than
anticipated.
**M19 ADDED A ROW TO THIS LIST AND IT IS A LIVE HAZARD, NOT A TIDINESS ONE.** `UI_FAMILY` and
`MONO_FAMILY` now have their one definition in `src/abi.mjs`, and `src/wm/surface.mjs:26-27` and
`src/wm/taskbar.mjs:95` still spell them out. The renderer and the published advance table MUST
agree about the stack — a renamed font in one copy prices a font nothing draws, and every fitted
column is then wrong with no error anywhere. `bench/m19-advance/probe.py` is the alarm: it reads
`src/wm/surface.mjs`'s pair by regex at run time and refuses to conclude if either stops being a
quoted const.

## Architecture rules

These are the ones a plausible-looking change breaks. Each has a constraint number.

- **The kernel is a dedicated Worker. Never the main thread.** `Atomics.wait` throws in a window
  agent, and a main-thread kernel inherits every long main-thread task as syscall latency —
  measured, 52 of 20,000 calls past 10 ms. (1, 3)
- **A process holds only integers.** No fd, OPFS handle, pipe buffer, window handle or lock lives
  in a process worker. `terminate()` offers no chance to finish, so anything releasable is
  kernel-side. (15)
- **The shell is a userland client of the same ABI — with one stated exception.** Explorer and the
  window manager use the same syscalls as a third-party app, and if they need a privilege they
  cannot express as a capability they were granted, the boundary is fiction.
  **The taskbar is the exception, and the earlier blanket claim was false.** It needs cross-process
  window enumeration that no ordinary client may have, and a per-process window fd cannot name
  another process's window. SerenityOS gives its taskbar a *second* endpoint on a separate socket
  with an event mask and `(client_id, window_id)` identity pairs the ordinary endpoint cannot
  enumerate. So the honest form of the invariant is **a second, separately-gated management
  interface** — still a capability the kernel granted, so the boundary survives, but it is not the
  same interface. (`docs/research/09-hobbyist-os-actions.md` §4)
  **M14 resolved it the other way, and the resolution is `docs/DECISIONS.md` D39.** The Superbar,
  the start menu, a jump list and the desktop's icons are rendered PAGE-SIDE, so no endpoint is
  needed: the page already holds every window's frame — `win-create` built it, `win-stack` ordered
  it — and a shell reading facts the page was already told adds no capability to anything. A
  taskbar as a *process* would still need that second endpoint, and a process could not draw one
  anyway: the display list had no text op and no image op, and a `WEV_POINTER` arrives only while a
  button is down. **M15 ADDED A TEXT OP (constraint 293) and the conclusion is unchanged**: a shell
  needs hover, a menu that outlives a button press, and a rubber band, and none of those is a
  drawing op. What the text op bought is a process that can draw a LIST — `files` and `taskmgr` —
  which is what the missing op had actually been costing. **What keeps the division honest is that the shell's CONTENTS are a process's**:
  `src/bin/desktop.mjs` reads the filesystem and publishes rows through `win_items`, and
  `scripts/check.py --negative no-items` is the run that tells that apart from a page drawing a
  hard-coded menu. (constraints 275, 223)
- **No `fork`.** `spawn` + `pipe` + `setpgid` only. (20)
- **Processes get fds, never paths.** Resolve a path to an inode once, in the kernel, and cache.
  `getDirectoryHandle` is 85 µs per component. (24)
- **`open()` is rare, fd I/O is common.** `createSyncAccessHandle` is 495 µs — 100× a syscall. (22)
- **`fsync` is a separate call from `write`.** (23)
- **Signals arrive through the SAB control word**, checked at syscall entry. A process parked in
  `Atomics.wait` cannot service `postMessage`. (16)
- **Blocking parks with a finite re-arm interval and checks a kernel heartbeat.** Never an
  unbounded wait, and never fault a process on timeout alone. (46)
- **Teardown is not reap.** At `terminate()`: close fds, destroy windows, drop the taskbar button.
  The ~2 s quarantine protects the pid and the SAB, never the pixels. (14)
- **Signals, broadcasts and sweeps are O(interested), never O(N).** Round-tripping every live
  worker costs 378 µs each. (18)
- **The process table has a hard cap.** The renderer dies between 3,200 and 4,800 workers and
  every process shares it. (17)
- **A program's realm is STRIPPED before its text is evaluated, and the policy is served on
  `src/libos/`.** Two halves, measurably disjoint: `src/libos/lockdown.mjs` removes the bindings
  (ambient OPFS above all) and a Content-Security-Policy on the response that creates the realm
  bounds the module loader, because `import(expr)` is not `fetch` and no scanner can catch it.
  Adding a binding back is reverting M6; a capability a userland program needs arrives as a
  syscall. It is HARDENING, NOT A SECURITY BOUNDARY — say so wherever it is described. (41, 53,
  187, 199)

## Deliberate decisions that look like bugs

Do not "fix" these. Each is load-bearing and each has a reason recorded.

- **The OPFS blob directory is flat, named by inode.** Not a workaround — it is how a real
  filesystem works, and it is what makes rename O(1) and hard links expressible. (26)
- **Writes are buffered; only `fsync`, snapshot and idle flush.** `flush()` is 260 µs against a
  5 µs write. This is POSIX's own contract. (23)
- **A bad superblock mounts read-only and reports.** It never reseeds. webxp reseeds; that is the
  defect being fixed, and it is silent data loss presented as success. (28)
- **A published data object is SEALED, and `dataobj_set` on it answers -EPERM.** Two processes
  reading one object must not be shown different bytes, so a source cannot rewrite what it put on
  the clipboard. (242)
- **A drop whose event did not queue is NOT retained.** A target with a full queue drops its newest
  event — the drop — so retaining the payload would charge the budget for a collection that can
  never happen, and a MOVE source would be told to delete the original. Effect 0, counted. (245)
- **The glass frame is FOUR separately filtered strips, not one node with an opaque child.**
  `backdrop-filter` filters the element's border box, so an opaque client area hides the blur and
  saves none of it. Measured at 640×440: four strips filter 27,260 CSS px² against 281,600 for the
  box — and the box figure reproduces gap-04's measured ~51 windows exactly, which is what makes
  the ring figure trustworthy. `D13`'s "~11× cheaper" is true of the ring and false of the box.
  Twelve DOM nodes per frame is the price, and it buys the only geometry in which constraint 49's
  governor can account the border box and still get the ring. (49, 255, D35)
- **Minimize and maximize are drawn and DISABLED.** Windows 7's own rule for an inapplicable
  caption command, and honest: there is nothing to minimize into until M14's taskbar, no snap
  state to maximize to, and the window ABI has no state property — `WIN_SET_TITLE`, `WIN_SET_BOX`,
  `WIN_SET_MODAL` and nothing else. A live-looking button that silently did nothing is the defect.
- **A credential is an argument on every path call, not instance state.** Otherwise every process
  shares one identity and the mode bits are decoration. (29)
- **A clipboard payload and a drag payload are KERNEL-OWNED, and a process holds an fd.** Both
  gestures need the bytes to outlive the process that made them — a clipboard whose payload lived in
  the copying process is empty the moment it exits, and a drag must survive its source dying
  mid-gesture. So a data object is `F_DATA`: teardown releases it and a process still holds only
  integers. `read(2)` and `write(2)` on one are -EINVAL, because an untyped read of a typed object is
  the ABI defect M10 removed. (240, 241)
- **The drag SESSION is the kernel's; the page reports only where the pointer is.** The page
  hit-tests — it has the DOM — and the kernel decides which window may be a target, because only it
  knows a window is blocked. `WinMgr.feed` REFUSES the four drag records from the page's own route.
  There is no `DRAG_OVER`: an event per motion sample laps a 256-record queue in about a second and
  `push` drops the newest, which would be the drop itself. (243, 244)
- **The window surface is KERNEL-OWNED, and a process draws by sending a display list.** This
  file said the opposite until M8 measured it: a transferred `OffscreenCanvas` does not arrive at
  a process that is spinning OR parked in `Atomics.wait`, only at one that awaits a macrotask — so
  it cannot be the reply to the call that asked for it, and a surface given away cannot be
  accounted or revoked (constraint 219, `docs/DECISIONS.md` D31). The window ABI is still `win_*`
  calls rather than a `/dev/wm` device file, but for the reason a window needs identity, an owner
  and an fd — not because of a transfer.
- **Enter, Tab and Backspace are NOT in the keysym table, and adding them is a regression.**
  `bytesForKey` already spells them 10, 9 and 127, so every program that reads them reads bytes —
  a keysym row for any one of them takes the key away from all of them. The space is disjoint by
  construction and `selfTest` asserts it both ways (constraint 299). It is also why **Enter cannot
  be the clause that proves the keysym path**: Enter reaches a process on a tree where the table
  does not exist.
- **A double-click's count comes from the browser and rides the DOWN record only.** The threshold
  is the reader's own, so a program that timed two presses itself would disagree with every other
  application on their machine; and `event.detail` is meaningful on the UP of a double-click too, so
  a program reading both would open a row twice for one gesture (constraint 300).

## Code conventions

- **No dependencies, no build step, no framework.** ES modules served as files, as in the
  predecessor. A dependency must be justified where it is introduced, and vendored with its
  licence beside it.
- **`.mjs` for modules, `.py` for tooling.** Python is stdlib-only except `websocket-client` for
  CDP, in a `.venv`.
- Layout: `src/kernel/` (the only privileged code), `src/libos/` (the in-process syscall stubs and
  the realm lockdown), `src/wm/` (userland), `scripts/` (tooling), `bench/` (harnesses that
  produce numbers), `www/` (what the browser loads).
- **`src/libos/` is the trust boundary in file form.** Anything added there runs inside a process,
  so review it as untrusted-adjacent: it must not acquire a capability the kernel did not hand it.
- A syscall number, errno or SAB offset is a named constant in one place, imported on both sides.
  Two copies hand-synced across the kernel/process boundary is the defect this rule exists for.
- **A page's entry point goes BELOW every declaration, at the bottom of its module.** `www/m17.html`
  called `main()` about 800 lines above a `const` its live branch reads, so the bare URL threw
  `Cannot access 'LIVE_PROGRAMS' before initialization` in both engines while the suite — which
  loads `?proofs=1` — stayed green. `scripts/check_pages.py` cannot catch it: `node --check` parses
  and does not execute (288), and a temporal dead zone is a runtime error. Below every declaration
  is the only position in which an entry point cannot be in one (301).

## Verification

The harness is the point. `../webxp/scripts/check.py` is 82 checks in 11,991 lines, and 59 of them
are not geometry assertions — `check_boot`, `check_mount`, `check_filesystem`,
`check_fs_persistence`, `check_terminal`, `check_routes` port into this project's spine.

- **Every check needs a negative control** that breaks the thing the check is about. Breaking
  something adjacent proves nothing.
- **Preserve `--prove-failure`**: it inverts every registered check's expectations so the run must
  report failures. A harness nobody has seen fail is a harness nobody has checked. Inversion is a
  **per-check declaration, not a maintained tuple** — a list kept beside the checks drifts from
  them, so `Control.INVERT` is mandatory and the opt-out needs a reason string that `audit()` reads.
  It exits 0 when the proof *succeeded*; non-zero is reserved for a proof that failed.
- **Inversion alone does not prove a check is coupled to its subject**, because an assertion over a
  constant still inverts and still fires. Only a negative control closes that, which is why every
  check must declare one that is re-runnable and scored.
- **A check whose measurement does not exist without a capability must declare that**, with a
  reason. Then the no-isolation control is satisfied by the measurement going away — which is what
  lets a kernel check, whose SAB is not constructible without COOP/COEP, be registered at all. An
  *undeclared* unmeasurable check is a stray and fails the gate.
- **A window manager cannot be checked by screenshot.** An inert frame and a working one are the
  same picture. Drive real input, read the geometry back.
- **Glass cannot be checked against a flat backdrop.** `blur(flat) == flat`, so the assertion
  passes with the blur switched off. Sample across a high-contrast seam and assert the gradient.
  (50) **And "the gradient" must be its SPREAD, not its monotonicity** — a hard step is monotonic,
  measured, so every one of M11's own negative controls satisfies a monotonicity test (256). **The
  span floor is not redundant with the spread test**, because the viewport-anchored specular
  highlight has a gradient of its own and was found satisfying the spread assertion over a flat
  desktop (259). `scripts/check.py --negative flat-desk` is the run that found it, and
  `--prove-failure` could not have: an assertion over a constant still inverts and still fires.
- **A threshold on a continuous input gets hysteresis, and both edges get checked.** **But ask
  first whether the input is continuous in the governor's OWN output.** M12's first blur governor
  summed only the windows that still had glass, so flattening one lowered the input and re-admitted
  it — a feedback loop that made two edges necessary, and that also created a stuck state no edge
  could fix. Summing the all-glass cost makes the input independent of the action: the governor
  settles in one pass and the band between the edges cannot change the outcome. The loop was the
  defect, not the absence of damping — and a `no-hysteresis` control against the corrected version
  broke nothing, so it was replaced by one that restores the loop (269).
- **A control must move a NAMED subset of expectations**, declared in its `Expect(failed=..)`. A
  control satisfied by any failure verifies nothing. M3's first control spun a poll loop hard enough
  to lap the trace ring and so also failed a proof it was not about; the poll was paced rather than
  the control re-scoped.
- **A COALESCING CLAUSE MUST USE A HELD PROGRAM, AND MUST SETTLE THE GEOMETRY FIRST.** Against a
  DRAINING fixture every record goes straight to a parked reader, so there is no tail to replace and
  `coalesced` stays 0 in both worlds — the clause inverts, fires, and verifies nothing. `--no-drain`
  is what makes it assertable, which is M17's lesson and then M19's. And `coalesced` is now shared by
  THREE mechanisms — M16's client-box replacements, M17's wheel sums, M19's hovers — so a clause that
  does not assert the geometry count unchanged across its stream may be reading a resize as a hover.
- **A TABLE INDEXED BY A UNIT MUST BE INDEXED IN THE UNIT THE OP CARRIES, and that is what decides
  whether it is ratio-shaped.** M19's advance table is indexed in SURFACE px — `DL_TEXT`'s `a2`, and
  the space `measureText` runs in — and moves **0.0000 px** across dpr 1 / 1.5 / 2 within one engine
  while moving 0.4522 px across engines. Indexed in CSS px it would have been the fourth ratio bill
  after 264, 297 and M11's band. Ask which space the measurement happens in before choosing the
  index (302).
- **A SIZE SET DERIVED IN PYTHON IS NOT THE SET JAVASCRIPT DRAWS AT.** `Math.round` is half-UP and
  Python's `round` is half-to-EVEN: 11 CSS px at dpr 1.5 is JS 17 and Python 16. A set derived with
  the wrong rounding publishes a row nothing draws at and omits one two programs do, with no error
  anywhere, because an undeclared size falls back by design (303).
- **Assert each refusal's errno separately.** A single "it refused" passes for a filesystem that
  refused for the wrong reason. M3's `truncate` answered ENOENT where it owed EROFS, and only the
  per-call assertion caught it.
- **A timeout MUST carry state.** A stopped pipeline raises no error anywhere — a parked reader and
  a parked writer are both legitimate — so the only way to tell a working pipe from a deadlocked
  one is to read the counts. `www/m4.html` attaches the kernel's park and refcount dump to its own
  timeout, and that dump is what located constraint 92 in one run.
- **A test double MUST NOT be gentler than the thing it stands for.** M4's pipe probe gave the
  kernel a fake `raise` that did not reap, so an entire class of double-reply defect was invisible
  to 68 passing assertions. A fake that cannot reach the real failure tests a world that does not
  exist.
- **`node -e "import('./src/kernel/kernel.mjs')"` is the fast syntax check.** A duplicate import
  surfaced in the browser as `worker.onerror` with the message `undefined`; node named it at once.
- **A PAGE's inline module needs the same gate, and `scripts/check_pages.py` is it.** A `const`
  shadowing a binding fifty lines above it in `www/m14.html` took `--only m14` **420 seconds** to
  report, as BROKEN with `never became true within 420.0s`: the page threw before it rendered, and
  a harness can only wait for a state that will never arrive. `node --check` over the extracted
  module names the line in about a second. It parses and does not execute (constraint 288).
- **The page at the obvious URL is the PRODUCT, and the proofs are the opt-in.** `www/m14.html` is
  the desktop; `?proofs=1` is the harness. It was the other way around and three reported defects
  came out of it, none of which was a defect — the proofs stage fixture windows and then block in
  `gestureAsker`, which looks exactly like a broken product. Any page blocking on a gesture now
  paints a banner saying so (constraint 283).
- **Kill stray Chrome between control runs.** `pkill -f "showup-chrome-"`. A leftover competes for
  the renderer: a twelve-control sweep without it reported `patched-optional` BROKEN, and the same
  control passed alone.
- **A DRIVEN WHEEL'S DELTA IS NOT IN THE SAME UNIT IN BOTH DRIVERS, so a dispatched constant is
  not an assertable distance.** CDP's `deltaY` is DEVICE px and the `wheel` event reports
  `deltaY / devicePixelRatio`; WebDriver BiDi's `scroll` takes CSS px. Measured 12 of 12 over four
  deltas at three ratios (constraint 297), and the dpr-1.5 non-integers are what ruled out a clamp.
  **A check that dispatches a constant delta and asserts a constant offset is right at dpr 1 and
  wrong by the ratio everywhere else, with every expectation green** — the same shape as M11's,
  M12's and M16's bills. Scale by the ratio, or assert against the delta the page received.
- **FIREFOX CAN BE DRIVEN NOW, and the rule below is why that matters.** `scripts/bidi.py` speaks
  WebDriver BiDi to Firefox 156: `input.performActions` delivers events carrying
  `isTrusted === true`, verified by its own self-test. `bench/m7-win/firefox.py`'s "Mozilla removed
  CDP, so there is no driver" was true of CDP and is no longer true of the browser. So a second
  engine can be ASSERTED in and not only photographed, which is the whole class constraint 40
  names. `bench/m14-shell/firefox-drive.py` is the first gate built on it, and it exists because a
  reader twice reported being unable to open anything on a desktop whose Chrome suite was green
  (constraints 289-292). The registered suite stays Chrome-driven: one engine, one set of measured
  constants.
  **AND FIREFOX CAN BE DRIVEN AT A CHOSEN RATIO, so "Firefox renders at dpr 1" is true of its
  DEFAULT and is no longer a limit.** `browsingContext.setViewport` with `devicePixelRatio` is
  honoured by Firefox 156, verified by reading `devicePixelRatio` back off the page at 1, 1.5 and 2 —
  which is how `bench/m19-advance/probe.py` covered three ratios in a second engine. `scripts/bidi.py`
  does not wrap it yet; call it directly, as that probe does.
- **The suite drives Chrome only, and that has now cost two milestones.** M4a shipped a window
  that could not be dragged in Firefox (175) and M6 shipped a policy under which no process
  started in Firefox at all (206) — both with every expectation green, both found by a human
  opening the page. Before reporting a milestone done, open it in a second engine.
  `firefox --headless --screenshot` is enough, because these pages print their own log.
  **It has now cost four.** M11's blur band was placed at a constant pixel offset and Firefox
  renders at dpr 1, where a caption's text-free gap is 3 device rows rather than 7 — so the band
  overlapped the glyphs and the proof failed on an engine whose glass was fine. **A geometry
  derived from a measured rect survives a second engine; one derived from a constant does not.**
  M12 repeated it exactly: `413 windows to the budget` is a dpr-2 figure, and Firefox at dpr 1
  needs 1,651 — so the assertion failed on an engine whose governor was fine. The claim is a floor
  now, and the exact figure lives in the host probe where the ratio is pinned (264).
  **IT HAS NOW COST FIVE, and the fifth was not a ratio.** `www/m17.html`'s bare URL threw before
  it rendered, in BOTH engines, while the Chrome suite was green — found by
  `bench/m17-wheel/firefox-scroll.py` being the first gate to load the product URL rather than
  `?proofs=1` (301). A gate in a second engine is also a gate on the path a reader takes.
- **A PLATFORM FACT MUST BE READ OFF THE EVENT THAT CARRIES IT, AND BOTH ENGINES MUST BE ASKED
  WHICH ONE DOES.** M18 took a double-click's count from `event.detail` on a `pointerdown`, where
  a pointer event carries no click count — so no double-click reached any program, in any engine,
  and 15 of 38 expectations went red with nothing thrown anywhere.
  `bench/m18-keys/clickcount.py` is what answers it: print the field per event kind, in both
  engines, with the pointer capture the host really takes, before building a record out of it (300).
- `bench/` harnesses must assert `crossOriginIsolated === true` and **abort** rather than report a
  number from a non-isolated context. `scripts/serve.py --no-isolation` exists to prove they do.

## Running it

```sh
scripts/serve.py                    # ...then http://127.0.0.1:8000/www/ IS THE DESKTOP: the
                                  # preflight, and then the Windows 7 shell. No milestone page,
                                  # no query parameter. The server is the repo root with
                                  # COOP/COEP on 8000
scripts/check.py --only landing     # the landing page's gate: 17 expectations
scripts/check.py --negative launcher-stale  # ...and the world where a program landed in /usr/bin
                                  # and the desktop's launcher allowlist never heard about it
python3 bench/shell-landing/firefox-landing.py  # CAN A READER OPEN THE DESKTOP IN FIREFOX?
python3 bench/shell-landing/firefox-landing.py --prove-failure  # ...and with a window parked on
                                  # the icon column, it cannot
scripts/serve.py --no-isolation     # omit the headers, to prove a check fails without them
scripts/check.py                    # the suite
scripts/check.py --prove-failure    # invert every expectation; the run MUST report failures
python3 bench/m7-win/drive.py --page m14 --live   # THE WINDOWS 7 DESKTOP, in a real Chrome
                                  # --live is HEADED and waits for you to close the window; it
                                  # binds its own server on a port the OS picks and prints the URL
python3 bench/m14-shell/input-probe.py  # WHICH DOM events CDP input really delivers (279)
scripts/check.py --controls         # what negative controls exist and what each proves
node bench/m7-win/probe.mjs        # M7's window table and one window, under node
node bench/m8-surface/probe.mjs   # M8's surface accounting and the display-list codec
node bench/m12-governor/probe.mjs # M12's accounting, both hysteresis edges, the degrade order
bench/m12-governor/shell.py       # type `winopen -n 4` at a REAL prompt and watch the glass go
scripts/check.py --negative stale-costs  # ...and the world where the governor cannot settle
python3 bench/m12-governor/probe.py --headed  # WHAT the blur budget binds on: area vs passes (266)
python3 bench/m12-governor/probe.py  # ...and headless it REFUSES to conclude, which is the point
scripts/check.py --negative top-first  # the governor degrading from the wrong end of the stack
python3 bench/m11-glass/probe.py  # WHY the glass frame is four strips, as a measurement (255)
python3 bench/m11-glass/probe.py --headed   # ...in the engine gap-04 measured Aero in
bench/m11-glass/shell.py          # `ls /usr/bin` at a REAL prompt on the Aero desktop
bench/m11-glass/scan.py           # WHERE in a caption the glass is clean: one figure per row
bench/m11-glass/drive.py          # M11's page in a real Chrome, with the pixels sampled
bench/m11-glass/drive.py --live   # ...or just the Aero desktop, left open to type into
bench/m11-glass/drive.py --no-blur   # and the four worlds its controls produce: blur(0px),
bench/m11-glass/drive.py --sever     # a wrapper at opacity .99, the glow gone, and no seam
scripts/check.py --negative flat-desk  # constraint 50 as a world: blur(flat) == flat
node bench/m10-data/probe.mjs     # M10's object lifetimes, format refusals and drag edges
bench/m10-data/controls.py        # nine mutations of them, scored on which checks move
bench/m10-data/shell.py           # `files &` and `imgview &` at a REAL prompt, and a REAL drag
bench/m10-data/shell.py --row 2   # ...the SAME gesture with a text file, which must be refused
bench/m10-data/shell.py --clip    # `clip copy` then `v`, which is the route a terminal has
node bench/m9-modal/probe.mjs     # M9's stack, owner chain and blocker walk
bench/m9-modal/controls.py        # five mutations of the modality rules, scored
bench/m9-modal/shell.py           # type `editor` at a REAL prompt and press its X; --clean inverts it
bench/shell-reports/repro.py      # two bugs a reader found by USING the desktop, at a real prompt
scripts/check.py --negative no-mountpoints  # ...and the world where `ls /` prints nothing
bench/m8-surface/controls.py      # five mutations of the accounting, scored on which checks move
bench/m8-surface/probe.py         # WHY the surface is kernel-owned, as a measurement (219)
bench/m7-win/firefox.py --page m8 # M8 in a second engine; read the PNG it writes
bench/m7-win/controls.py          # five mutations of it, scored on which checks move
bench/m7-win/drive.py             # open www/m7.html in a real Chrome and print what it reported
bench/m7-win/drive.py --live      # ...or just the desktop, left open to type into
bench/kernel-churn/probe.py --drop  # the program fetch, dropped at the transport (constraint 212)
node bench/m6-realm/probe.mjs      # M6's lockdown under node, including its refusal path
bench/m6-realm/controls.py          # and three mutations of it, scored on which checks move
bench/m6-realm/csp-probe.py         # WHERE a policy must be delivered, measured not assumed
scripts/serve.py --no-csp           # omit the process realm's policy, to prove a check fails
scripts/fsfuzz.py                   # the fs codecs under Node + 10k torn journals (no browser)
scripts/check_links.py              # every path reference in the authored docs resolves
scripts/check_pages.py              # node --check over every www/*.html inline module (1 s)
scripts/check_pages.py --prove-failure  # ...and it MUST report the redeclaration it injects
scripts/bidi.py                     # FIREFOX WITH REAL TRUSTED INPUT, over WebDriver BiDi
python3 bench/m14-shell/firefox-drive.py  # CAN A READER OPEN ANYTHING? the launchers, in Firefox
python3 bench/m14-shell/firefox-drive.py --prove-failure  # ...and the world where they cannot
python3 bench/m14-shell/firefox-hover.py  # CAN THE POINTER REACH A THUMBNAIL? the flyout, crossed
python3 bench/m14-shell/firefox-hover.py --prove-failure  # ...with no grace period, it cannot
python3 bench/m14-shell/coreutils.py      # mkdir, rm -r, cp, mv, sort, uniq at a REAL prompt
python3 bench/m17-wheel/probe.py    # WHAT UNIT IS A DRIVEN WHEEL DELTA? four deltas, three ratios
node bench/m17-wheel/probe.mjs      # ...and the clip RESET between batches, under node
python3 bench/m17-wheel/firefox-scroll.py  # DOES THE LIST SCROLL IN FIREFOX? real trusted input
python3 bench/m17-wheel/firefox-scroll.py --prove-failure  # ...and with a zero delta, it must not
python3 bench/m18-keys/firefox-keys.py   # DOES A ROW OPEN AND DOES THE KEYBOARD REACH IT? in Firefox
python3 bench/m18-keys/firefox-keys.py --prove-failure  # ...and with `j` for the arrow, it must not
python3 bench/m18-keys/clickcount.py     # WHICH EVENT CARRIES THE CLICK COUNT? both engines
scripts/check.py --only m18         # M18's 38 expectations. 15 are RED on this tree, on one
                                  # listener — see MILESTONES.md M18
scripts/check.py --negative one-click-opens  # every DOWN record carries a count of 2, so a single
                                  # click activates a row
scripts/check.py --negative no-handler-table # ...and the world with no file association, where
                                  # `files` refuses BY THE ROW'S OWN NAME
scripts/check.py --negative keysym-as-byte   # ...and a keysym packed into the byte field: the
                                  # arrow clauses fall and every BYTE key holds
scripts/check.py --only m19         # M19's 60 expectations over five driven proofs, 20.3 s
python3 bench/m19-advance/probe.py  # CAN A COLUMN BE FITTED FROM A PUBLISHED TABLE? two engines,
                                  # three ratios, 17 sizes. Mono YES to 0.0000 px, proportional NO
                                  # — and the error has one sign, so the sum is an UPPER BOUND
python3 bench/m19-advance/probe.py --prove-failure  # ...four controls, each moving its own clause
python3 bench/m19-hover/probe.py    # WHAT DOES A 500-MOVE HOVER STREAM COST? appended vs replaced,
                                  # into a DRAINING program and a HELD one (constraint 223)
python3 bench/m19-hover/firefox-hover.py  # ...the held pair again, with REAL trusted input
python3 bench/m19-host/drive.py     # the PAGE's half alone: a hover, a leave, a cursor, a refusal
python3 bench/m19-host/drive.py --prove-failure  # ...and the world where the guard is back
python3 bench/m19-page/firefox-m19.py     # www/m19.html in Firefox, through the page's own decoder
python3 bench/m19-details/firefox-details.py  # DOES THE DETAILS VIEW SORT AND LIGHT UP IN FIREFOX?
                                  # on the LANDING page, with real trusted input
python3 bench/m19-details/firefox-details.py --control held-button  # ...and with the button HELD,
                                  # the three hover clauses fire and the three order ones hold
scripts/check.py --negative stable-sort-off   # a tie group that follows the sort's direction
scripts/check.py --negative folders-last      # ...and directories after files
scripts/check.py --negative no-dir-stat       # ...and a folder with no Date cell, because nobody
                                  # paid for the call
scripts/check.py --negative band-from-row     # ...and a press on a row that bands instead of dragging
scripts/check.py --negative no-hover-coalesce # ...and a hover stream APPENDED into a held program
python3 bench/m16-resize/probe.py   # IS A RESIZE GRIP DRIVABLE, and at a dpr the run chose?
scripts/check.py --negative no-clip          # a scrolled row painting over its own header
scripts/check.py --negative unclamped-scroll # ...and a list that scrolls past its end
scripts/check.py --negative no-wheel-coalesce # ...and a wheel stream that laps the event ring
python3 bench/coep-tiles/probe.py   # the worked example: a real harness with a negative control
```

**`serve.py` defaults to the repository root**, resolved from its own path rather than the caller's
cwd, so it works from any directory and `/www/`, `/mockups/` and `/bench/` are all reachable from
one server. That default exists because `www/m0.html` imports `/src/abi.mjs` and `/bench/...` and
cannot be served from `./www`. Dot-prefixed paths 404 and are hidden from listings, since the root
contains `.git`.

`bench/syscall-contention/probe.py` binds its own server on the right root, so it needs none of
this. `www/m0.html` carries a module-graph preflight, so serving it from the wrong root says which
imports 404'd rather than rendering a blank screen.

`python3 -m http.server` **will not work** — it cannot send COOP/COEP, so `SharedArrayBuffer` is
undefined and nothing boots. `www/index.html` gates the desktop behind a preflight that refuses to
proceed and says which capability is missing, which is the only reason that failure reads as a
sentence rather than a blank page.

## When a constraint looks wrong

Measure it. Do not reason it away, and do not assume the number in `docs/CONSTRAINTS.md` is stale
because it is inconvenient.

Every figure there names the harness that produced it, on Chrome 157 / macOS 26.7.2 / Apple M2
Pro / 120 Hz / dpr 2. If your machine differs, say so beside the new number rather than replacing
the old one. If a constraint is genuinely falsified, update it, cite the evidence, and note the
correction — `docs/CONSTRAINTS.md` already carries one 4× arithmetic error that was caught and
fixed that way, and the record of it is more useful than a clean file.

## Scope

Milestone order is risk order: the riskiest assumption is tested first, which is why M0 is one day
and comes before anything else. Do not reorder to get something visible sooner — M4a already
exists for that reason.

Finish a milestone's proof and its negative control before starting the next. A milestone without
a failing-capable check is not done, however much of it is written.

## Path conventions in the docs

Three kinds of path appear, and telling them apart matters because two of them do not exist in
this repository.

- **`docs/…`, `scripts/…`, `src/…`, `bench/…`, `www/…` in `CLAUDE.md`, `README.md`, `CONTEXT.md`,
  `PLAN.md`, `MILESTONES.md`, `docs/CONSTRAINTS.md`, `docs/ABI.md`, `docs/DECISIONS.md`** — paths
  in *this* repo, written **relative to the repository root** wherever they appear. Some are
  forward references to files a milestone has not created yet, and `MILESTONES.md` records each
  as owed. `scripts/check.py` is no longer one of them — it is the harness, documented above.
- **`../webxp/…`** — the predecessor, a sibling checkout, also
  <https://github.com/nchafy/webxp>. Always written with the prefix in the authored docs.
- **Bare `src/…` or `scripts/…` inside `docs/designs/` and `docs/research/`** — these are
  generated artifacts kept verbatim as evidence, and a bare path in them usually means either a
  webxp file or a file that design proposed and which was never built. **Do not go looking for
  them here.** Resolve against the surrounding text, and prefer the authored docs above as the
  statement of what exists.
