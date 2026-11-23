# PRD — the file manager and the shell

What `files` and the Windows 7 shell must become, why, and what the ABI owes them. Architecture is
not restated: `CLAUDE.md`, `docs/ABI.md`, `docs/DECISIONS.md` D31/D37/D39 carry it. Constraints are
cited by number from `docs/CONSTRAINTS.md` (296 of them as of M15).

This is a requirements document. It proposes no design and no schedule.

---

## 1. What this is for

A reader opened the desktop at the bare URL (`www/m14.html`, the product per constraint 283) and
reported four defects.

| # | Report | Mechanism | Address |
| --- | --- | --- | --- |
| 1 | The file viewer has no scroll | There is no wheel event in the ABI and no wheel listener in the page, so the program caps its list at 24 rows and states the overflow | `src/abi.mjs:460-461` (`WEV_ITEM: 12, WEV_MAX: 12`), `src/bin/files.mjs:69`, `:228` |
| 2 | Expanding the window horizontally does not work | The canvas is a flex item with the default `flex: 0 1 auto`, so its CSS width never follows the client area | `src/wm/aero.mjs:404`, `:419` |
| 3 | Files cannot be opened from the file viewer | `files` has no activation path at all: its pointer arm only selects, its key arm accepts one key, and the ABI carries no click count | `src/bin/files.mjs:440-473`, `:478`, `src/wm/winhost.mjs:545-560` |
| 4 | Resizing makes the content huge and blurry | Three causes, below. The canvas's CSS height is stretched to the client area by the flex cross axis, its backing store keeps the size the process asked for, and that size was already in the wrong unit | `src/wm/aero.mjs:401-409`, `src/wm/surface.mjs:48-49`, `src/bin/files.mjs:242` |

**Bugs 2 and 4 are one defect with three causes, and the brief named one of them.** The brief
attributed the stretch to every surfaced program discarding `WEV_RESIZE`. That discard is real
(`src/bin/files.mjs:439`).

The second cause is that the shipped Aero stylesheet gives the canvas no CSS box:
`.aero-desktop .window-body canvas { display: block; background: #fff }` (`src/wm/aero.mjs:419`) is
the only canvas rule in the skin, while the four proof pages each paste
`.surface { … width:100%; height:100% }` (`www/m7.html:32`, `www/m8.html:29`, `www/m9.html:31`,
`www/m10.html:31`) that `www/m14.html` does not have. So the product and the proofs render different
geometry, which is why 57 green M14 expectations coexisted with this bug.

**The third cause is a unit error, it is the larger half, and it is present before anything is
resized.** `win_surface` takes device pixels; every surfaced program passes CSS-shaped constants.
§2 is that defect stated once, and the rest of this document depends on it.

**Measured at dpr 1, on 2026-11-22, in Chrome 1440×900 headless in this worktree.** A page importing
`src/wm/aero.mjs`, `src/wm/window.mjs` and `src/wm/surface.mjs`, building one frame around a 420×98
surface and reading `getBoundingClientRect`:

| Frame (CSS px) | Client area (CSS px) | Canvas CSS box |
| --- | --- | --- |
| 440×138 (what `files` asks for) | 428×103 | 437.1×102.0 |
| 900×138 | 888×103 | 437.1×102.0 |
| 440×600 | 428×565 | 2417.1×564.0 |
| 300×138 | 288×103 | 437.1×102.0 |

Three facts follow. The canvas is already 9 px wider than its client area at the moment the window
opens, and the surplus is cut by `overflow: hidden` (`src/wm/aero.mjs:409`). Widening the frame
changes the canvas by nothing — the reader's bug 2. Making it taller scales it 5.76× and clips 82 %
of its width — the reader's bug 4. **A fix to the program alone will not close either**, and a fix
to the CSS alone will not reveal one extra row.

**That table is not re-runnable and it understates the defect.** The page that produced it is not
committed, and the figures were taken at dpr 1 while CLAUDE.md's reference machine is dpr 2 — so
they miss the unit defect entirely and **understate the blur by a further 2×**.
`bench/m16-resize/probe.py` is owed as a committed probe, and MUST re-derive the table at both
ratios, the second under `--force-device-scale-factor=2`.

Bug 1 is independent and ABI-deep: there is no input event to scroll with and no display-list op to
clip a scrolled region against. Bug 3 is independent and shallow: `spawn` is already available to
any process (`src/libos/syscall.mjs:478`) and `src/bin/desktop.mjs:322` already uses it from inside
a windowed program; what is missing is a gesture the ABI can express and a caller in `files`.

Three further defects were found during the audit and are included because they are in the same
gesture and the same files. **One of the three has since been fixed in code and is kept here
because its check has not landed:**

- **`taskmgr` tested the pointer modifier against the y coordinate. FIXED, in commit `de8a68a`,
  and only the registration is still owed.** The defect was `if (!(ev.b & WPTR_DOWN)) continue;`:
  `ev.b` is y (`src/abi.mjs:402`, `pointerAt` at `:1424`) and `WPTR_DOWN` is `0x10`
  (`src/abi.mjs:464`), so a press selected a row only in the band of each 18-px row
  (`src/bin/taskmgr.mjs:54`) where `y & 0x10` was set. The current line is
  `if (!(ev.mods & WPTR_DOWN)) continue;` (`src/bin/taskmgr.mjs:341`), matching
  `src/bin/files.mjs:443` and `src/bin/paint.mjs:184`, with the history kept as a comment at
  `:334-340`. **What has not landed is a registered check**: the gate is
  `bench/m14-shell/taskmgr.py`, and `grep -n taskmgr scripts/check.py` is empty, so the fix rests on
  a bench nobody re-runs in the suite. R10 is that registration.
- **A right-click inside a surfaced window raises the browser's own menu over the OS.**
  `#wirePointer` (`src/wm/winhost.mjs:545`) wires pointerdown/move/up/cancel/keydown/focus/blur from
  `:562` and no `contextmenu`; the three `preventDefault` call sites are page chrome only
  (`src/wm/window.mjs:280`, `src/wm/desktop.mjs:174`, `src/wm/taskbar.mjs:347`).
- **`files`'s own header comment states the opposite of what the program does.**
  `src/bin/files.mjs:20-24` says "THE ROWS HAVE NO LABELS AND THAT IS NOT AN OVERSIGHT … there is no
  text op", and M15 added `DL_TEXT` and the program now draws real text rows (`:289-345`). A stale
  comment in the file R7, R20 and A8 all edit is a reader's first wrong turn.

---

## 2. Units, and the client box

**Conflating two units is the larger half of the reader's bug 4.** Four units exist and each has
one home.

| Unit | What is measured in it | Where it is fixed |
| --- | --- | --- |
| **CSS px** | a frame's box; `win_create`'s `w`/`h`; `WIN_SET_BOX`; `WIN_CAP_H: 29` and `WIN_INSET: 6` (`src/abi.mjs:741-743`); `MIN_W: 220`/`MIN_H: 120` (`src/wm/window.mjs:40-41`); every number in `src/wm/aero.mjs` | `src/wm/window.mjs` |
| **device px** | `win_surface(fd, w, h)` — "`w` × `h` DEVICE pixels, and the kernel allocates it" (`docs/ABI.md:185-186`); `SURFACE_BUDGET_PX`/`SURFACE_MAX_PX` (`src/abi.mjs:648-652`); the blur governor's accounting, `blurRingArea(…) * this.dprSq` (`src/kernel/wins.mjs:1091`) | `src/abi.mjs` |
| **surface px** | every display-list coordinate, and `DL_TEXT`'s `a2` size (`src/wm/surface.mjs:119`); a `WEV_POINTER`'s `a`/`b` (constraint 223) | `Surface.pointAt`/`clientAt` (`src/wm/surface.mjs:164-186`) |
| **cells** | `WEV_RESIZE`'s `a`/`b`, and `winsize` | `src/kernel/wins.mjs:387` |

**A surface pixel and a device pixel are NOT the same unit, and this document used to treat them as
synonyms.** The rule, stated once:

- A **surface** pixel is the **process's own** unit: a coordinate in the backing store it asked for.
  Its extent is whatever the process passed to `win_surface`, and nothing else in the system knows
  that number.
- A **device** pixel is the **display's**. `win_surface`'s arguments are device pixels because they
  are a request against a budget the kernel keeps in the display's unit.
- **They coincide only when the surface is the full client content box.** A smaller surface is
  stretched to the box by CSS, deliberately (`src/wm/surface.mjs:33-35`), and `www/m8.html`'s 4×4
  pattern is the standing counter-example: four surface pixels across a whole client area.
- So: **the display list takes surface pixels** and an **event carries surface pixels** — the two
  halves `pointAt` and `clientAt` already convert between, as declared inverses. **A size request
  takes device pixels.** R2's job is to make the two coincide at rest, which is what lets a program
  convert with the dpr alone; it does not merge the units.

The factor between CSS px and device px is the device-pixel ratio, and **a process cannot learn it.**
The only dpr channel runs page → kernel (`src/wm/winhost.mjs:95` → `src/kernel/kernel.mjs:2033`) and
the kernel keeps only the square, `this.dprSq = 4` (`src/kernel/wins.mjs:545`). No syscall, no
`/proc` row and no event carries the ratio. `grep -rn dpr src/` is **not** the evidence for that —
re-run, it hits a comment at `src/abi.mjs:650` and the `dprobe`/`dround` locals in that file's own
self-test (`:2082-2091`), and every process imports `src/abi.mjs`. The reproducible form is
`grep -rn "dprSq\|devicePixelRatio\|win-dpr" src/`: three files, all of them the kernel or the page
(`src/kernel/wins.mjs`, `src/kernel/kernel.mjs`, `src/wm/winhost.mjs`).

**Every surfaced program passes a CSS-px constant to `win_surface`, and the reference machine is
dpr 2.** `files` declares `SURFACE_W = 420` (`src/bin/files.mjs:56`), hands it to `win_create` as
`SURFACE_W + 20` (`:232`) and to `win_surface` unchanged (`:242`) — the same integer in two units.
At dpr 2 a 420-device-px backing store is painted into a 428-CSS-px client area, which is 856 device
px: **a 2× upscale before any resize happens.** The other four do the same — `imgview` 200×200
(`src/bin/imgview.mjs:40-41`, `:105`), `taskmgr` 560 (`src/bin/taskmgr.mjs:57`, `:179`), `paint` and
`editor` from their own frame arithmetic.

Three obligations follow, and they bind every section below.

- Every size in a requirement, an ABI addition, a milestone or a check clause MUST name its unit.
- The client-area event MUST carry **device pixels and the dpr together**, because a program holds
  CSS-px constants and has no other route to the ratio.
- A program MUST scale its CSS-px layout constants by the dpr before they reach `win_surface`.

### The client box is measured, never modelled

**The client box MUST NOT be derived from `WIN_CAP_H` and `WIN_INSET`.** The derivation
`(w - 2·INSET) × (h - CAP_H - INSET)` is wrong twice over.

- `.aero-desktop .window-body` carries `border-top: 1px solid` (`src/wm/aero.mjs:406`) and is not
  `box-sizing: border-box` — the only two in the file are `:232` and `:258`. An absolutely
  positioned box with `top`, `bottom` and `height: auto` solves its height so the **border** box
  spans the offsets, so the content box the canvas fills is 1 px shorter than the derivation says.
- `www/m7.html`, `m8.html`, `m9.html` and `m10.html` do not import `aero.mjs` at all —
  `grep -n aero www/m7.html` is empty. On four of the five hosts that render a surface those
  constants describe no element on the page.

The page already measures. `#report` reads `entry.win.bodyEl.getBoundingClientRect()`
(`src/wm/winhost.mjs:671`) and derives the terminal's cell count from it. The instrument for the
canvas's own extent is `bodyEl.clientWidth`/`clientHeight` — the **content** box, which excludes the
border the bounding rect includes. Constraint 264 and CLAUDE.md's finding are the rule: *a geometry
derived from a measured rect survives a second engine, and one derived from a constant does not.*
M11's blur band and M12's budget figure each cost a milestone to the other choice.

**The partition identity stays, and it is NOT universal.**
`blurRingArea(w,h) + max(0, w - 2·INSET)·max(0, h - CAP_H - INSET) === blurBoxArea(w,h)` holds for
every `h` **when `w >= 2·WIN_INSET`**, and fails otherwise. It fails for every
`0 <= w < 2·WIN_INSET` with `h > WIN_CAP_H`, because `blurRingArea`'s `sides` term does not depend on
width — `2 * WIN_INSET * Math.max(0, height - WIN_CAP_H)` (`src/abi.mjs:1765`) — while the
complement clamps to zero. Measured, with
`node -e "import('./src/abi.mjs').then(m=>{const c=(w,h)=>Math.max(0,w-2*m.WIN_INSET)*Math.max(0,h-m.WIN_CAP_H-m.WIN_INSET);for(const[w,h]of[[0,100],[6,100],[11,200],[640,440]])console.log(w,h,m.blurRingArea(w,h)+c(w,h),m.blurBoxArea(w,h))})"`:

| `w` | `h` | ring + complement | `blurBoxArea` |
| --- | --- | --- | --- |
| 0 | 100 | 852 | 0 |
| 6 | 100 | 1,026 | 600 |
| 11 | 200 | 2,371 | 2,200 |
| 640 | 440 | 281,600 | 281,600 |

An exhaustive sweep of `0 <= w,h <= 400` by the same route reports failures at exactly
`w ∈ 0..11` and nowhere else.

**The narrow claim is the true one and it is enough**, because no window the clamp can produce has
`w < 2·WIN_INSET`: `clampBox` floors the width at `MIN_W` (`src/wm/window.mjs:109`, `MIN_W: 220` at
`:40`), which is 18× the bound. An assertion over the identity MUST therefore use inputs with
`w >= 2·WIN_INSET`, and MUST NOT include `w = 0` — **a self-test over `w = 0` fails the build**, and
the unclamped form of the complement is worse still (at `w = 300, h = 0` it is −10,080 against a box
of 0).

It is an identity about the **accounted** geometry, not a measurement of any element, so it checks
the governor and does not substitute for the measured box.

---

## 3. Where the system actually is

Short, per subsystem, so a reader can tell what works without opening the code.

**The surface.** Kernel-owned, drawn by display list, one renderer (`src/wm/surface.mjs`).
**Resizing a surface already works on both sides and is reachable by no input.** The kernel
releases the held area before charging the new one (`src/kernel/wins.mjs:1040`, `:1047`) and the page
destroys the old canvas and builds a new one (`src/wm/winhost.mjs:503-521`). No program in
`src/bin/` calls `win_surface` twice — the only four call sites are startup code
(`src/bin/files.mjs:242`, `src/bin/imgview.mjs:105`, `src/bin/paint.mjs:105`,
`src/bin/taskmgr.mjs:179`). Hit-testing survives any CSS scale, because `pointAt`/`clientAt` divide
by the live `getBoundingClientRect` (`src/wm/surface.mjs:164-186`) — which is also why no existing
geometry check could have caught bugs 2 and 4.

**The drawing ABI.** Six ops: `DL_CLEAR`, `DL_FILL_RECT`, `DL_STROKE_RECT`, `DL_LINE`, `DL_TEXT`,
`DL_TEXT_DATA`, `DL_MAX: 6` (`src/abi.mjs:595-625`). Text arrived in M15 as a header plus
continuation records with four flags — bold, mono, right, centre (`src/abi.mjs:630-633`). 2,043 ops
per call (`node -e "import('./src/abi.mjs').then(m=>console.log(m.DL_MAX_OPS))"`). There is no clip,
no transform, no image op, no gradient, no dash, no text measurement, and no `save`/`restore` in the
renderer (`src/wm/surface.mjs:81-145`). A text run's size is whatever the process sent:
`const size = Math.max(1, op.a2 | 0);` (`src/wm/surface.mjs:119`), so the renderer offers no closed
set of sizes — which A8 has to work around. A bitmap is one `DL_FILL_RECT` per **source** pixel,
which is why `src/bin/imgview.mjs:60` caps at `MAX_DRAW_PX = 1024` — a **count** of fill-rects,
32×32, not a length — and refuses anything larger by name (`:184-187`).

**The input ABI.** Twelve event types, all reachable (`src/abi.mjs:408-461`). Keys are printable
UTF-8 plus Enter, Tab, Backspace, Escape and Ctrl+letter; every other key returns null from
`bytesForKey` (`src/wm/terminal.mjs:15-36`) and is dropped before the kernel sees it
(`src/wm/winhost.mjs:599-600`) — so arrows, Home/End, Page, Delete, Insert and F-keys reach no
process. A pointer arrives only while a button is held (`src/wm/winhost.mjs:575`), so hover does
not exist, although `src/abi.mjs:463` documents `mods == 0` as the hover case. `WEV_RESIZE` carries
cells, not pixels (`src/kernel/wins.mjs:387`), and the cell metric is page-private
(`src/wm/winhost.mjs:91`, `:671-678`). No wheel event and no wheel listener anywhere. No click count
and no event timestamp (`src/abi.mjs:401-402`; the record is full at 16 bytes).

**`files`.** A one-shot read-only listing with a working drag source. It lists one directory once
(`src/bin/files.mjs:159`), sorts directories first then by raw byte order (`:200-203`), pays one
`lstat` per **non-directory** row — the call sits inside `if (!dir)` (`:193-195`) — and keeps only
the execute bit from it, caps at 24 rows and states the overflow (`:228`, `:295-300`), and draws
real text rows with a header and a right-aligned type column (`:289-345`). It cannot open, cannot
navigate, cannot enter a folder, cannot refresh, cannot delete, cannot rename, holds one selection,
and is not a drop target — `WEV_DROP`, `WEV_STATE` and `WEV_ITEM` have no branch in its loop and
fall off the end uncounted (`:438-486`).

**The filesystem.** Strong, and not the bottleneck. Every mutation verb a file manager needs already
has a syscall: `mkdir`, `rmdir`, `unlink`, `rename`, `symlink`, `link`, `chmod` (`src/abi.mjs:106-116`).
`filestat` already carries size and three nanosecond timestamps (`src/abi.mjs:1191-1194`) and the
`lstat` `files` already calls returns them. Durability is proven end to end
(`scripts/check.py` `check_m2`). The gaps are: the dirent carries name, inode and type only
(`src/abi.mjs:312-313`), so a Details view costs one `stat` per row **including every directory row,
which pays none today**; every file under `/usr`, `/proc` and `/dev` reports all three timestamps as
0 (`src/kernel/synth.mjs:125-127`); `utimes` is implemented and journalled (`src/fs/vfs.mjs:702-706`)
with no syscall number; `realpath` is implemented (`src/fs/vfs.mjs:509`) with no syscall number; the
libos `statfs` stub sends no path (`src/libos/syscall.mjs:833-834`) so only the root mount's figures
are reachable; there is no change notification of any kind; there is no trash; `/usr` is `EROFS` and
its contents are a frozen array in kernel source (`src/kernel/providerfs.mjs:28-99`, `:180`).

**The shell.** Substantially complete as Windows 7 chrome, and page-side per D39: grouped Superbar
buttons with the three-way click (`src/wm/taskbar.mjs:378`), a hover thumbnail flyout with a grace
period (`:62`), jump lists (`:340`), a two-column start menu with live search (`:733`), a tray clock
with Aero Peek and Show desktop (`:226`), a caption window menu (`:663`), a desktop icon view with
selection, a rubber band, a grid and two context menus (`src/wm/desktop.mjs:347`), Aero Snap with a
measured hysteresis pair (`src/wm/window.mjs:653`), eight working resize grips with per-direction
cursors (`src/wm/window.mjs:296`), and caption double-click (`:285`). The shell's contents come from
a process (`src/bin/desktop.mjs` publishes rows through `win_items`), and the shell decides nothing
the kernel owns (`src/wm/winhost.mjs:697`, `:742`, `:848`). What is absent: no window switcher of
any kind, a taskbar band whose comment says it scrolls while its CSS clips it
(`src/wm/aero.mjs:577-583`), a tray that is a clock and one button (`src/wm/taskbar.mjs:186-188`),
no pinning and no drop target on the bar, no process-owned popup or menu, and no common dialogs —
`WIN_SET_MODAL`'s two axes are fully enforced (`src/kernel/wins.mjs:642-668`, `:765-772`) with two
hand-rolled callers (`src/bin/editor.mjs:141`, `:165`; `src/bin/winopen.mjs:169`).

**The harness.** 18 registered checks (`grep -c '^@check' scripts/check.py`), boot through m14,
audited at import by `audit()` (`scripts/check.py:1014-1201`, 25 distinct refusals), 44
`NegativeControl` registrations, floors in `scripts/check_floors.json`.
**M15 shipped with zero registered checks and no floor** (`grep -ci m15 scripts/check.py` → 0; no
`m15` key in `check_floors.json`). **No check or page has ever driven a resize grip** (`grep -rn
grip scripts bench www` → nothing). No registered check reads a `DL_TEXT` run back
(`grep -c DL_TEXT scripts/check.py` → 0). No driver in either engine can dispatch a wheel:
`_perform_gesture` (`scripts/check.py:1958-2026`) raises `Unmeasurable` at `:2026` for any kind it
does not know, and `scripts/bidi.py:195-232` is pointerMove/Down/Up, pause, keyDown/Up. The
registered m14 check targets `?proofs=1`, not the page a reader opens (`scripts/check.py:4191`).
`src/wm/icons.mjs:307`'s `selfTest` is exported and called by nothing, where `src/abi.mjs:2371` and
`src/kernel/trace.mjs:166` call theirs at module load.

---

## 4. The product goal

A reader opening the bare URL MUST be able to do all of the following with a mouse and a keyboard,
without a terminal:

1. Open a folder window from a desktop icon or the start menu, and see every file in it — by
   scrolling with the wheel, the scrollbar, or the keyboard.
2. Make that window wider and taller and get **more content**, in focus, at every size. Make it
   narrower and lose nothing but visible rows.
3. Double-click a folder and be inside it. Go back, and up.
4. Double-click a file and have the right program open it.
5. See each file's name, type, size and date, and sort by any of them by clicking a header.
6. Select one file, a range with Shift, several with Ctrl, and a block with a rubber band.
7. Right-click a file and get **this system's** menu, not the browser's.
8. Make a new folder, rename a file, and delete one — with the delete recoverable.
9. Copy a file in one window and paste it in another; drag a file from one window to another and
   see which effect will happen before releasing.
10. Press F5 and see a change another program made.

Each of these is checkable by a person in under a minute. None of them is possible today.

---

## 5. Requirements

Tiers: **P0** table-stakes — without it the file manager is not a file manager; **P1** expected —
a Windows 7 user will reach for it in the first session; **P2** polish.

P0 is eleven requirements. Each is either one of the four reported bugs or a correctness defect
found beside them.

### P0 — the file manager is a file manager

| # | Requirement | Why | Depends on |
| --- | --- | --- | --- |
| R1 | A surfaced window's canvas MUST fill its client **content** box exactly, in both axes, at every frame size, with no clipping and no letterboxing. | Reported bugs 2 and 4. Windows 7's client area and its DIB are the same rectangle. | The sizing set by the renderer that owns the canvas, `src/wm/surface.mjs` beside `:48`, replacing the four pasted copies in `www/m7-m10.html`. No ABI change. |
| R2 | A surfaced program MUST be told its client content box in **device pixels**, with the **dpr** beside it, and MUST re-ask for a surface at that size when it changes. A repaint MUST follow, because the page destroys the old canvas (`src/wm/winhost.mjs:503-508`). | Reported bug 4's other two causes. `WEV_RESIZE` carries cells of a font a canvas program never renders (`src/kernel/wins.mjs:387`), and no program can learn the device-pixel ratio (§2). | **A2**, **A2b**. The kernel's re-surface path needs no change. |
| R34 | `imgview` MUST answer a client-box change by **re-rendering at the new size**, never by letting CSS scale the old backing store: the integer scale is recomputed from the new box in surface px and the image stays centred. | The reader's "expanding just expands a png" is this, and R2 alone does not say what to do with the room. Testable: at two client sizes the drawn pixel extent MUST differ and both MUST read back as flat colour blocks — a CSS-scaled canvas reads back as the old extent with interpolated edges. | R2, A2 |
| R3 | A surfaced window MUST receive a wheel event, and `files` MUST scroll on it: a proportional thumb, a draggable thumb, trough-click paging, and an offset clamped so the last row sits at the bottom edge. | Reported bug 1. It is the first gesture a reader tries, and constraint 294 currently makes the cap normative rather than the scroll (§9). | **A1**, **A6** (a scrolled row must not paint over the header `src/bin/files.mjs:289-303` draws). |
| R4 | A row MUST be openable: double-click, or Enter on the focused row. A directory row MUST navigate in place; a file row MUST launch the program registered for its extension; an unknown extension MUST refuse by name. | Reported bug 3. Windows 7's whole file-centric model is the default verb. | **A4** for the gesture; **A3** for the arrows that move the focus, **not** for Enter, which already arrives as byte 10 (`src/wm/terminal.mjs:29`); and the handler table moved out of `src/bin/desktop.mjs:76` (see R9). |
| R5 | `files` MUST navigate: into a directory, back, and up one level. The window MUST re-list on navigation and MUST show where it is. | A folder row that is drawn, selectable and inert is the defect a reader named as "the file system view is not correct" (`src/bin/files.mjs:42-52`). `dir` is read once at `:149` and the listing once at `:159`. | A2 (the title or a path strip is layout), A3 (Alt+Left / Alt+Up). Windows 7 has no Up *button* and binds Backspace to Back; the keys MUST follow that, not XP's. |
| R6 | Arrow keys, Home, End, PageUp, PageDown, F2, F5 and Delete MUST reach a process. **Enter already does** and is not in this list: `src/wm/terminal.mjs:29` returns byte 10 for it, so §3's "Enter works" and this requirement do not disagree. | `bytesForKey` returns null for every key in the list (`src/wm/terminal.mjs:15-36`, verified per key against `:29-34`) and `src/wm/winhost.mjs:599-600` drops them. Keyboard operation of a list is an accessibility floor, which `src/wm/window.mjs:778-781` already cites WCAG SC 2.1.1 for on the frame's own gestures. | **A3** |
| R7 | A Details view MUST show Name, Date modified, Type and Size, and clicking a header MUST sort — ascending, then descending, with directories always first and Size blank for a directory. | Details is the default Explorer view for non-media folders and the only one in which size and date are readable. The data is partly in hand: `files` pays an `lstat` per non-directory row and discards `size` and `mtimeNs` (`src/bin/files.mjs:193-195` against `decodeFilestat`, `src/abi.mjs:1185-1195`). | One `lstat` per row, for **every** row — a folder's Date modified needs a call nothing currently pays, and the dead `dir ? …` ternary inside `if (!dir)` at `:194` goes with it. **A10** is the cost fix, not the capability. |
| R8 | A right-click inside a surfaced window MUST NOT raise the browser's context menu. | A foreign menu drawn over the operating system is the clearest possible breach, and it blocks R16 from being testable. | One `contextmenu` listener in `#wirePointer` (`src/wm/winhost.mjs:545`), matching the three existing call sites. |
| R9 | The extension → program association MUST have exactly one definition, reachable by every program. | It lives inside one program today: `OPENS_FILES` at `src/bin/desktop.mjs:76`, unreachable from `files`, a shell `open` verb or a context menu. Its two siblings `FORMAT_BY_EXT` and `iconForPath` are in `src/libos/std.mjs:278`, `:315` for exactly this reason. | No ABI change. |
| R10 | `taskmgr`'s row selection MUST carry a **registered** check. The code fix has landed (`de8a68a`, `src/bin/taskmgr.mjs:341`); the gate is `bench/m14-shell/taskmgr.py` and the suite does not run it. | The keys `t` and `x` kill whatever the selection landed on (`src/bin/taskmgr.mjs:270-281`), so a regression here kills the wrong process. CLAUDE.md: a fixed bug MUST become a check — a bench is not the suite, and `grep -n taskmgr scripts/check.py` is empty. | Nothing in the product. One registration, and the `ev-b-pointer` control that restores the defect. |

**R1 is about the canvas's CSS box, and it does not forbid scaling.** A backing store smaller than
that box is still stretched to it, by design — `src/wm/surface.mjs:33-35` states that contract, and
`www/m8.html`'s 4×4 pattern proof reads its pixels back through exactly that stretch
(`www/m8.html:25-30`). R2 is what makes the backing store follow the box, so a stretch is what a
reader sees **during** a drag and not after it, which is also what Windows 7 shows.

**R34 carries no "box too large to draw" refusal, because nothing can trigger one.** `MAX_DRAW_PX`
bounds the **source**: `drawBitmap` emits one `DL_FILL_RECT` per source pixel
(`src/bin/imgview.mjs:133-152`) and absorbs the client box into `scale` (`:134`), so the op count is
`bmp.w * bmp.h` whatever the box becomes, and the refusal at `:184-187` is a property of the image
and not of the window. A requirement MUST NOT oblige a refusal its own arithmetic makes
unreachable — that is the live-looking-button defect in clause form. The ceiling a growing box
really meets is `SURFACE_MAX_PX` (`src/abi.mjs:652`), on the `win_surface` call rather than on the
draw, and `docs/PLAN-SHELL.md` §5 prices it against the largest client box at dpr 2.

### P1 — a Windows 7 user reaches for it in the first session

| # | Requirement | Why | Depends on |
| --- | --- | --- | --- |
| R11 | Hover: the row under the pointer MUST light, a header MUST light, and a truncated name MUST raise a tooltip after a delay. | `src/bin/files.mjs:22` already claims "the row under the pointer is outlined" and the code can only set `hot` on a press (`:443-447`), because a buttonless move is dropped at `src/wm/winhost.mjs:575`. Explorer's row affordance is hover. | **A5**, **A8** (a tooltip needs to know the name was truncated), **A12** for the cursor half. Amends constraint 223 — §9 |
| R12 | Selection: click sets the anchor, Ctrl+click toggles and moves it, Shift+click selects the inclusive range in **layout** order, Ctrl+A selects all, and the focused row carries a focus rectangle distinct from the selection. | These are the gestures every Windows user has in their fingers; the anchor rule is what makes Shift-after-Ctrl predictable. `files` holds one integer (`src/bin/files.mjs:413`). | A3, A4 |
| R13 | A rubber band MUST select by intersection, live, when the press starts on empty space; a press on a row MUST start a drag instead. | It is how a block of files is selected. The arbitration belongs to the program, which is why the ABI needs nothing new: a move arrives while the button is held, which is exactly a band's lifetime. | Nothing beyond A4 |
| R14 | New folder, rename in place (F2, with the basename selected and the extension excluded), and delete MUST work from the window. | Windows 7 renames inline, never in a dialog. Every syscall exists (`src/abi.mjs:106-116`). Two things block it today: the default directory is `EROFS` (`src/bin/files.mjs:41` against `src/kernel/providerfs.mjs:180`) and Delete and F2 cannot be delivered. | A3, A6 (the edit box must clip), A8 (a caret at a clicked character needs a measurement), and a writable default location |
| R15 | Delete MUST confirm, MUST be recoverable, and the Recycle Bin MUST be a navigable location with Original Location and Date Deleted, Restore, and Empty. | An irreversible Del is a different operating system. `src/bin/desktop.mjs:187` records the absence: "THERE IS NO RECYCLE BIN … nothing in this system has a trash". The icon already exists with no store behind it (`src/abi.mjs:721`, `src/wm/icons.mjs:252`). | A reserved directory plus a sidecar; **A11** (`utimes`) for Date Deleted fidelity; a restore that refuses rather than overwrites |
| R16 | A context menu on a row and on empty space, raised by right-click, Shift+F10 and the Menu key, with inapplicable rows greyed and not hidden, closing on Esc or an outside click. | It is where most file operations are invoked in Windows 7, and the keyboard route exists so it is not mouse-only. A process has no route to a menu at all today. | **A9**, R8 |
| R17 | Cut, Copy and Paste over files, with cut rows at half opacity until the paste completes, `name - Copy` on a same-folder paste, and a Replace / Skip / Keep both dialog on a collision. | Copy and paste between two windows is the central file-management act. The typed clipboard already exists and `DOBJ_PATHS` is already a format (`src/abi.mjs:781`); `clip` already offers it (`src/bin/clip.mjs`). | Nothing new in the clipboard. A dialog, which `WIN_SET_MODAL` already enforces (`src/kernel/wins.mjs:765-772`) |
| R18 | Drag and drop MUST show its effect before release: MOVE within a volume, COPY across, Ctrl forcing copy and Shift forcing move, a highlighted drop target, and Esc cancelling. `files` MUST be a drop **target**, not only a source. | The two-pane shell exists for the cross-window drag. The kernel already owns the session and already decides which window may be a target (`src/kernel/dataobj.mjs`, constraints 243-244); `files` simply never reads `WEV_DROP`. | A4 (modifiers already ride the record), R14 for the MOVE half |
| R19 | F5 and a Refresh row MUST re-read the directory, preserving the selection where the rows survive. | Two windows on one folder that disagree produce an error a reader cannot explain. `files` never re-lists, and the desktop's refresh row is published `WITEM_MENU \| WITEM_JUMP` (`src/bin/desktop.mjs:271-277`) — so it reaches the start menu and the desktop window's jump list, and **not** the desktop's own right-click menu, which is the one place a reader looks for it. | A3 |
| R20 | A scrolled or clipped region MUST be bounded, and a name too long for its column MUST be ellipsised rather than overrun. | Explorer clips every column and every scroll viewport. `NAME_MAX` is 255, so a 60-character name overruns `TYPE_RIGHT` (`src/bin/files.mjs:63`) with no op able to stop it. | **A6**, **A8** |
| R21 | The taskbar band MUST reach every button. | `src/wm/aero.mjs:577-583`'s comment says "It SCROLLS RATHER THAN SHRINKS past its width" above `overflow: hidden`, and the shrink floor is 42 CSS px — so past it, a live window has a frame and no reachable button. Windows 7 adds scroll arrows at exactly this point. | Nothing. Page-side. |
| R22 | A window switcher MUST exist, with a published chord. | A buried window is reachable only by clicking its frame or its button, and R21 shows there may be neither. Captions are Tab-reachable (`src/wm/window.mjs:196`) and focus is reported to the process (`src/wm/winhost.mjs:448`) while `win-raise` is posted only from a pointerdown (`:441`) — so a keyboard user types into a window that stays buried. | **A14** (the substitute-chord table). Alt+Tab itself is interceptable; see §7. |
| R23 | A tray icon MUST be publishable and withdrawable by a process, and MUST be withdrawn on teardown. | The tray is a clock and one button (`src/wm/taskbar.mjs:186-188`), so a background program has no way to show it is running. An icon outliving its process is the classic tray defect. | An **eighth** `WITEM_*` bit, `0x80`. Six are declared today under `WITEM_FLAGS_ALL: 0x3f` (`src/abi.mjs:684-697`) and A9 takes the seventh, `0x40`, so `WITEM_FLAGS_ALL` goes `0x3f` → `0x7f` → `0xff` and `src/abi.mjs:2211`'s self-test asserts the OR at each step |
| R24 | Taskbar pinning MUST persist across a reload, and a pinned-but-not-running button MUST launch. | The Superbar's identity is that launcher and switcher became one button. The bar is empty on a fresh desktop. D39 forbids a page-side launch route (`src/wm/taskbar.mjs:101-106`), so a pinned row MUST be a published item the desktop process owns. | R9, a persisted shell config file — §8.2 |
| R25 | Open and Save As MUST exist as one shared dialog, and a message box MUST exist. | In Windows 7 any program gets file naming without implementing a browser. Today every program hand-rolls it: `src/bin/editor.mjs:156-175` draws its own question window, and its "save and close" writes `[saved]` to the **window** fd and not to the file (`src/bin/editor.mjs:247`, admitted at `:87-88`) — a reader is told their edit was saved and it was not. | R9's handler table, A3, **A9** |

### P2 — polish

| # | Requirement | Why | Depends on |
| --- | --- | --- | --- |
| R26 | Thumbnails at Medium icons and larger: an image file's icon IS the image, with a fallback to the type icon. | A 16×16 icon is 256 fill-rects today, so a 24-row listing is 6,144 ops in four syscalls for icons alone. Nothing in this system decodes a PNG (`src/bin/imgview.mjs:76-82` reads the signature and IHDR and says "THIS IS NOT A DECODER"). | **A7**, plus a decode performed where a decoder exists — not inside a locked-down realm (`src/libos/lockdown.mjs`) |
| R27 | View modes: Extra Large / Large / Medium / Small Icons, List, Details, Tiles, remembered per folder. | Windows 7 ships eight on a continuum; a viewer with one layout is a listing. List is the only mode that scrolls sideways, and its column-major flow is what distinguishes it from Small Icons. | A1 (Ctrl+wheel is the slider), A6, A8 |
| R28 | A breadcrumb address bar that becomes an editable path on a click in the empty strip, with Alt+D focusing it. | It is the single most identifying piece of Windows 7 chrome, and the dual nature is the behaviour, not the pixels. | A8 (segment hit rectangles need measured widths), A3, A11 (`realpath`) |
| R29 | A navigation pane with a splitter, and a Details pane showing the selection's count and summed size. | Explorer's two-pane identity; the Details pane is the only place a selection's total size appears. | A5, A8 |
| R30 | Column resize by dragging a divider, with double-click auto-fit, and per-folder persisted widths. | A fixed-width Name column is the first thing a user reaches for. | **A8** for auto-fit, **A12** for the cursor |
| R31 | Search in the folder window, filtering as it is typed. | Windows 7 made search part of every folder window. The walk MUST be chunked so the window keeps servicing input, and MUST be bounded — there is no recursive helper in `std` and two hand-rolled walkers already exist (`src/bin/rm.mjs:22`, `src/bin/cp.mjs:70`, each with its own `MAX_DEPTH = 64`). | A shared bounded walk in `src/libos/std.mjs` |
| R32 | Live update: a change another process made MUST appear without a manual refresh. | Two Explorer windows on one folder stay in agreement in Windows 7. There is no change notification (`src/bin/desktop.mjs:19`), and `poll` on a directory fd reports `POLLIN\|POLLOUT` unconditionally (`src/kernel/calls.mjs:1330-1332`), so a program that built a watch on it would spin instead of parking. | **A13** or a bounded poll, plus a fix to the directory-fd `poll` answer |
| R33 | Grouping, header filters, Libraries, Tiles and Content views, Aero Shake, Cascade / stacked / side-by-side, balloon notifications, Control Panel. | Each is Windows 7 behaviour and none is load-bearing for a file manager. Listed so they are not mistaken for oversights. | Various; all additive |

---

## 6. The ABI additions

Fourteen additions. Thirteen are additive — no record widens and no existing field is
reinterpreted — and every new number in those thirteen extends a dense table whose self-test
already audits it, except A12's `WCUR_*`, which is a **new** table and therefore owes a self-test of
its own, the way `src/wm/icons.mjs:307` does for `WICON_*`.

**A10 is the exception and it is the only one.** One of its two shapes widens the `dirent` record,
which is why that shape carries the 4-byte-alignment obligation stated under A10 and why the other
shape — a `readdir` flag returning a dirent-plus-stat record — leaves the existing record alone. The
choice between them is not taken here.

**This document assigns no numbers.** `docs/PLAN-SHELL.md` assigns them in landing order, which is
the only order in which a dense table stays dense; two documents assigning the same number is two
definitions of one fact. What this document fixes is the **free space** and the **field layout**.

**Where the free space is.** `NSYS` is 60, `WEV_MAX` is 12, `DL_MAX` is 6 and `WIN_SET_*` uses 1-5
(`src/abi.mjs:481-496`), all verified by
`node -e "import('./src/abi.mjs').then(m=>console.log(m.NSYS, m.WEV_MAX, m.DL_MAX))"`. `DL_RESERVED`
is a written-zero word in every 32-byte op record (`src/abi.mjs:584-590`), so a seventh argument is
available without changing `DLOP_BYTES`.

**`mods` is ONE namespace and it needs ONE allocation.** `mods` is a u16 at offset 2 of **every**
event record (`src/abi.mjs:402`, written at `:1399`), and the three modifier bits are set on the two
record types the page produces — `WEV_KEY` (`src/wm/winhost.mjs:463-465`) and `WEV_POINTER`
(`:551-553`). So a per-type sub-table that reuses a value is a collision waiting for the first
reader that masks before it switches. One
allocation, asserted pairwise disjoint and single-bit by one self-test clause —
`src/abi.mjs:2145` does that for `[WPTR_DOWN, WPTR_UP, WPTR_MOVE]` and `:2152`/`:2322` for the
modifiers, **separately**, which is how two sub-tables could come to overlap at all.

| Bits | Who, and on which types |
| --- | --- |
| `0x1` `0x2` `0x4` | `WMOD_SHIFT`/`CTRL`/`ALT` — reserved on every type, set on key and pointer |
| `0x8` | `WMOD_META` (A3) — reserved on every type, set on key and pointer |
| `0x10` `0x20` `0x40` | `WPTR_DOWN`/`UP`/`MOVE` — pointer |
| `0x80` `0x100` `0x200` | `WPTR_CLICK2`, `WPTR_CLICK3` (A4), `WPTR_LEAVE` (A5) — pointer |
| `0x400` `0x800` | `WWHEEL_PAGE`, `WWHEEL_COALESCED` (A1) — wheel |
| `0x1000`-`0x8000` | free |

**Every KERNEL-PRODUCED event MUST be added to `WinMgr.feed`'s refusal.** `feed` is a refusal list,
not an allowlist: it refuses the four drag records (`src/kernel/wins.mjs:1445-1448`) and then
`WEV_STATE` and `WEV_ITEM` (`:1454-1457`, counted as `stats.forgedKernelEvents`) because "a
`WEV_STATE` the page posted would tell a program it had been minimized when the kernel believes
otherwise". A2's client event is identical in kind — the kernel computes it from the box the page
reported, and a page-posted one would tell a program a size it does not have — so it MUST be refused
with the same counter. A1's wheel event is **not**: a wheel is a browser event and the page is its
only honest source. But `WWHEEL_COALESCED` is the kernel's flag, so `feed` MUST mask it out of any
wheel record it accepts, or a page can tell a program that twenty notches arrived as one.

### A1 — a wheel event

`a` = signed dx, `b` = signed dy, in the window's own unit — **surface pixels** for a surfaced
window, **cells** for a text one, which are the two units `WEV_POINTER` and `WEV_RESIZE` already use
(constraint 248). Surface pixels and not device pixels: a wheel delta is a coordinate in the
process's own backing store, like every other coordinate it reads, and §2 carries why the two are
not interchangeable. `c` = the pointer position, in surface pixels, packed as two i16. `mods` carries the
modifier bits plus `WWHEEL_PAGE`, distinguishing a line delta from a page delta. Sign is restored by
a new `wheelAt(ev)` beside `pointerAt` — `a` and `b` are u32 in the record, and constraint 225 is the
existing record of what happens when a caller reads a signed coordinate raw.

**The constraint it must respect is constraint 243, the no-`DRAG_OVER` argument, applied again.**
`WIN_EVENT_CAP` is 256 (`src/abi.mjs:477`) and `push` drops the **newest** record
(`src/kernel/wins.mjs:298-301`), so an uncoalesced wheel stream can lap the queue and the record
discarded is the most recent scroll — the list would scroll backwards under the reader's hand. So:
**the kernel MUST coalesce**, by summing `dx`/`dy` into the tail record when the tail is already a
wheel record with the same `mods`. A coalesced record MUST set `WWHEEL_COALESCED` so a reader can
tell one notch from twenty. The page MUST also call `preventDefault`, or the host scrolls the
document under the desktop.

**The instrument for coalescing is `queued:`, not `dropped:`.** `dropped` increments only when the
ring is full (`src/kernel/wins.mjs:298-301`), and a 300-notch stream into a 256-record ring drained
by a polling program drops nothing — so a `dropped == 0` clause passes whether or not the kernel
coalesced, and a control that breaks the coalescing moves nothing. `queued:`
(`src/kernel/procfs.mjs:99`) counts records that **entered** the ring: one per drained batch
coalesced, one per notch not. A `coalesced:` counter beside it, incremented by each sum or
replacement, is the direct reading and MUST be published for the same reason `suppressed` is.

**And the lapping this argument rests on is only reachable against a program that is not draining**,
which is why §8's proof holds one in a declared `--no-drain` mode rather than asserting a scroll
direction a draining program can never produce.

### A2 — the client box, in device pixels, with the dpr

A new event type. `a` = client **content** width, `b` = client content height, both in **device
pixels** — the unit `win_surface` takes (`docs/ABI.md:185-186`) and the unit `SURFACE_MAX_PX` is
sized in (`src/abi.mjs:648-652`). `c` = the device-pixel ratio in 16.16 fixed point, because a
program holds CSS-px constants and §2 shows it has no other route to the ratio.

**The box is the page's measurement, not the kernel's model.** §2 carries the two reasons. The page
posts `bodyEl.clientWidth`/`clientHeight` × dpr in its existing `win-geom` message, which already
measures that element for the cell count (`src/wm/winhost.mjs:671`); the kernel records and
forwards, as it does for the box itself.

`WEV_RESIZE` MUST keep carrying cells unchanged. `src/bin/term.mjs:277` reads `ev.b`/`ev.a` as rows
and columns and feeds them to `winsizeSet`, and `src/bin/winopen.mjs:272` counts them — a
reinterpretation would resize a terminal's grid to 640×440 columns.

The client event MUST be raised whenever the client **pixel** box changes, which `WEV_RESIZE` is
not: `src/kernel/wins.mjs:385-387` suppresses an event for any resize that changed no cell count.

**A2b — the box MUST be reported during the drag, not only at release.** `src/wm/window.mjs:754-755`
ends the resize `move` handler with `this.box = next; this.apply();` and posts nothing. `#report`
has seven call sites (`src/wm/winhost.mjs:277`, `:433`, `:446`, `:447`, `:653`, `:778`, `:813`) and
**none of them is in the gesture**; the one the gesture relies on is the frame's `pointerup` at
`:446`. Two consequences, both already forbidden elsewhere. `/proc` and `WinMgr.governBlur`'s
`blurRingArea(win.box.w, win.box.h)` (`src/kernel/wins.mjs:1091`) describe the pre-drag rectangle
for the whole gesture, which is constraint 49's under-read in the direction constraint 49 exists to
forbid — and `src/wm/winhost.mjs:257-259` states the rule this path breaks. Worse, when
`setPointerCapture` throws — Firefox does, constraint 175, and the gesture continues on document
listeners (`src/wm/window.mjs:763-772`) — a release outside the frame never reaches that hook, so
the kernel keeps the pre-drag box **permanently**.

**A2c — `/proc/<pid>/win/<winid>` MUST publish the surface, the client box and the dpr.** `winLines`
(`src/kernel/procfs.mjs:69-100`) prints `box:` and `cells:` and no `surface:` line, although the
kernel holds `win.surface = { w, h }` (`src/kernel/wins.mjs:1049`). A process MUST be able to read
back the geometry it was granted, in the unit it was granted in, without waiting for an event.

**A2d — a re-surface MUST NOT steal focus.** `src/wm/winhost.mjs:525` runs
`entry.surface.el.focus()` on every `win-surface` message, including the resize branch that just
destroyed the previous canvas. Harmless today because nothing re-asks; it fires on the first program
that does, yanking the keyboard to a window on every resize.

### A3 — keys that are not bytes

A dense `WKEY_*` table in `src/abi.mjs`: the four arrows, Home, End, PageUp, PageDown, Delete,
Insert, F1-F12, Menu. Delivered as a `WEV_KEY` whose `a` **is 0** and whose keysym is in `c`.

`a == 0` is a free discriminator and the safest one available: `keyBytesOf` already returns an empty
array for a length outside 1..4 (`src/abi.mjs:1428-1436`), so every existing byte reader is
unaffected and a program that does not know the table sees a key with no bytes rather than a wrong
byte. The page MUST NOT synthesise ANSI escape sequences for arrows: a GUI list would have to parse
CSI out of a keystroke stream, and `src/kernel/pty.mjs`'s line discipline would mangle them for any
program behind a pty.

`bytesForKey` (`src/wm/terminal.mjs:15-36`) is the one translation and MUST stay the one
translation; it gains a keysym return beside its byte return, and both callers
(`src/wm/terminal.mjs:68`, `src/wm/winhost.mjs:598-608`) read the same function.

`WMOD_META` MUST be added. `src/wm/terminal.mjs:17` drops every Cmd/Win combination, and
`src/wm/window.mjs:778-781` already works around the absence by respelling Win+Arrow as Ctrl+Arrow.

### A4 — a click count

`WPTR_CLICK2` and `WPTR_CLICK3` in `mods`, set on the **DOWN** record, sourced from the browser's own
`event.detail` so the page keeps owning the timing threshold it already owns for its `dblclick`
listeners (`src/wm/desktop.mjs:173`, `src/wm/window.mjs:285`).

**It MUST NOT go in `c`.** `pointerAt` returns `buttons: ev.c >>> 0` (`src/abi.mjs:1424`), so a
count in `c`'s high bits makes `buttons` a nine-digit number, and any caller comparing it for
equality rather than masking gets a wrong answer.

A program MUST NOT be expected to time two DOWN records itself: the record carries no event
timestamp, so the only interval it could measure is queue latency plus scheduling after a `poll`
wake, not the reader's timing.

### A5 — hover

No new type. `src/abi.mjs:463` already documents "A move with no button held is a hover, which is
the zero case", and the kernel already accepts it; `src/wm/winhost.mjs:575`'s `if (!e.buttons)
return;` is the one line that makes the documented case unreachable. Removing it MUST come with
coalescing, for A1's reason — a hover has no history worth keeping, unlike a drag sample, so the
kernel MUST **replace** a tail pointer record whose `mods` is `WPTR_MOVE` with no buttons rather
than append. A `WPTR_LEAVE` edge MUST be added, from a `pointerleave` listener: without it a program
is never told the pointer left and a hover highlight never clears.

The coalescing is read through `queued:` and `coalesced:`, for the reason A1 states: a drained ring
never reports a drop.

The `#dragMove` call in the same listener (`src/wm/winhost.mjs:580`) MUST stay gated on a held
button.

This reverses constraint 223 — §9.

### A6 — a clip op

`a0..a3` = x, y, w, h, in **surface pixels** — the unit every other display-list coordinate is in
(§2). `flags` bit 1 = reset to the whole surface.

**PER BATCH, NOT PERSISTENT.** The surface is persistent across batches — `replay` never clears and
`DL_CLEAR` is an explicit op the process sends (`src/abi.mjs:595`, `src/wm/surface.mjs:81-145`) — so
a clip left set by batch N would make batch N+1 draw nothing, and the symptom is a window that goes
blank on its next repaint with no error anywhere. `replay` MUST reset the canvas clip at the top of
every batch.

An unknown op is already counted and not dropped silently (`src/wm/surface.mjs:139-141`), so a page
older than the process reports a version skew rather than a drawing bug.

### A7 — a blit op

`a0` = a **data-object fd** holding a `DOBJ_BITMAP` payload; `a1..a4` = destination x, y, w, h in
**surface pixels**, which is the unit every other display-list coordinate is in (§2); `a5` = a
source-rect index, 0 for the whole bitmap.

The payload header has exactly one definition already — `BMP_W: 0, BMP_H: 4, BITMAP_HEADER: 8` with
`encodeBitmap`/`decodeBitmap` (`src/abi.mjs:793`, `:1735`) — and a data object's bytes are
kernel-owned and refcounted (constraints 240, 241), so the lifetime problem is solved rather than
new. The kernel MUST validate the fd kind (`F_DATA`) and the payload length against
`BITMAP_HEADER + w*h*4`, answering `-EBADF` for a wrong kind and `-EINVAL` for a short payload,
**whole, before anything is drawn** — which is the rule `src/kernel/calls.mjs:1103-1115` already
applies to a malformed text run.

**Pixels MUST NOT travel inline in the batch.** A 32-byte record carries 24 payload bytes — six
pixels — which is worse than one `DL_FILL_RECT` per pixel, and it makes `win_draw`'s record count
stop meaning ops.

### A8 — text metrics as data, plus an ellipsis flag

**Not a syscall.** A round-trip per string is 100× a syscall by constraint 22's own order, and a
blocking measure inside a paint loop is the wrong shape.

A generated `/dev` row, built on the `src/kernel/synth.mjs` adapter ("a new one is two functions"),
publishing the advance width of every printable ASCII code point plus a mean advance for the rest,
per family (`UI_FAMILY` and `MONO_FAMILY`, `src/wm/surface.mjs:26-27`) and per size. Measured
**once**, page-side, with `measureText`, and posted to the kernel the way `win-dpr` already is
(`src/wm/winhost.mjs:95`).

**The set of sizes MUST be declared, because the renderer has none.** `const size = Math.max(1,
op.a2 | 0);` (`src/wm/surface.mjs:119`) accepts any positive i32, so "every size the renderer
offers" is not a closed set and a table per size cannot be built from the renderer. The sizes a
program may have a table for MUST be one declared list in `src/abi.mjs`, the renderer MUST keep
accepting any size, and a size outside the list MUST have no row — so a program drawing at one lays
out with the ellipsis flag alone and not with a wrong advance. The size is in **surface pixels**,
which is the unit the op's `a2` already is: `measureText` runs in the canvas's own coordinate space,
so the table is indexed in the unit the op carries and not in the display's.

Plus a `DLT_ELLIPSIS` flag on a text op, so the renderer — which has the real font — truncates. Belt
and braces, because the table is an approximation and the renderer is not.

**The constraint is constraint 264 and CLAUDE.md's own finding: a geometry derived from a measured
rect survives a second engine, and one derived from a constant does not.** `src/bin/files.mjs:60`'s
`GLYPH_W = 16` and `:63`'s `TYPE_RIGHT` are exactly the constants that cost M11 and M12 a milestone
each. The process receives **data**, never a measuring capability — constraint 41 and
`src/libos/lockdown.mjs` are unchanged.

### A9 — a menu a process can raise at a point

One new syscall, `win_menu(fd, x, y, byteregion)` with `x`/`y` in **surface pixels**, reusing
`encodeWinItems`/`decodeWinItems` verbatim (`src/abi.mjs:1483`, `:1526`) so the item record keeps one
definition, plus a `WITEM_CONTEXT: 0x40` bit — the seventh.

**Surface pixels and not device pixels, because the point a program has is the one it was given.**
A program computes a menu position from the `WEV_POINTER` that asked for it, and that record carries
surface pixels (constraint 223). The page converts with `Surface.clientAt`
(`src/wm/surface.mjs:177-186`), which is already the declared inverse of the `pointAt` that produced
the event — so the round trip has one arithmetic and not two, and a surface smaller than its client
box still puts the menu under the pointer.

Bounds are the ones `WinMgr.items` already enforces: `-EINVAL` past `WIN_ITEM_CAP` 64 or
`WITEM_LABEL_MAX` 64 (`src/abi.mjs:675`, `:680`), `-EBUSY` for a second menu while one is open.
Activation returns through the existing `WEV_ITEM` with `c = WITEM_CONTEXT`. **A dismissal MUST also
be reported**, because a program that opened a menu and was never told it closed holds a mode for
ever.

**The dismissal is a negative index, and it MUST arrive through a sign-restoring accessor.** `-1`
written into the record is read back as `4294967295`: `decodeWinEvent` reads `a` with `getUint32`
(`src/abi.mjs:1409`), and `WEV_ITEM` has no accessor to undo that the way `pointerAt` does for a
pointer's coordinates (`:1423-1425`). So A9 declares `itemAt(ev)` beside `pointerAt`, returning
`{ index: ev.a | 0, where: ev.c >>> 0 }`, and a dismissal is `index < 0`.

An accessor and not an unsigned sentinel such as `0xffffffff`, for the reason constraint 225 exists:
this ABI's answer to a signed field in an unsigned record is **one** place that undoes it, and a
sentinel instead asks every reader to remember that `a` is unsigned here and signed in a pointer
record. The kernel still validates — it writes the sentinel itself, so the index range check on a
real activation is unchanged.

`WITEM_FLAGS_ALL` MUST become `0x7f`: `src/abi.mjs:2211` asserts it is the OR of the declared flags
precisely so an unknown bit is refused.

**The program MUST NOT draw the menu into its own surface.** A Windows 7 menu extends past its
window's rectangle, `.window-body` is `overflow: hidden` (`src/wm/aero.mjs:409`), and a highlight
that tracks the pointer needs A5. The page renders and decides nothing, which is constraint 226 and
D39 unchanged.

### A10 — metadata in a listing

Either a widened dirent, or a `readdir` flag returning a dirent-plus-stat record. This is a **cost**
fix, not a capability fix: `src/bin/files.mjs:194` already pays one `lstat` per non-directory row,
and R7 extends that to every row.

If the dirent is widened, `DIRENT_HEADER` MUST stay 4-byte aligned. `direntSize(nlen)` is
`(DIRENT_HEADER + nlen + 3) & ~3` (`src/abi.mjs:1180`) and the self-test pins both the empty-name
case and the padding (`src/abi.mjs:1920`), because a header that is not 4-aligned unaligns the u64
the next record starts with. There are two spare bytes at offset 10 today
(`DE_NLEN: 9`, `DIRENT_HEADER: 12`).

The source matters: `src/kernel/calls.mjs:775-776` routes synth and tmpfs directories through
`listRel`, a different source from the VFS's `listIno` (`src/fs/vfs.mjs:491-497`) which already holds
the child inode — so `/usr/bin` needs its own change, and every row there currently reports all
three timestamps as 0 (`src/kernel/synth.mjs:125-127`).

### A11 — `utimes` and `realpath`

Two new syscalls. Both are **implemented and unreachable**: `src/fs/vfs.mjs:702-706` journals
`OP.UTIMES` and `src/fs/vfs.mjs:923-925` replays it; `src/kernel/tmpfs.mjs:122-123` forwards it;
`src/kernel/synth.mjs:247` refuses it; `src/fs/vfs.mjs:509` is a full symlink-resolving
canonicalizer. `docs/ABI.md:134` lists **both** as if they existed.

Without `utimes`, a copy cannot preserve a date and `atime` has no writer at all — the only
assignments are inode creation (`src/fs/vfs.mjs:258`) and the unreachable replay. Without
`realpath`, an address bar cannot canonicalize `/tmp/../usr/bin` without reimplementing the walk in
userland over `lstat` and `readlink`.

**`docs/ABI.md` MUST be reconciled with `SYS_NAME` by a check.** The document claims 71 calls
(`docs/ABI.md:3`); `SYS_NAME` is 60
(`node -e "import('./src/abi.mjs').then(m=>console.log(m.NSYS, m.SYS_NAME.filter(Boolean).length))"`
→ `60 60`). **The exact count of documented-but-absent calls is what the check computes, and this
document states none** — ABI.md names its calls in prose rather than in one table, so any figure
quoted here is a figure nobody can re-run. Ten names
are reproducibly on the wrong side of it, each by
`node -e "import('./src/abi.mjs').then(m=>console.log(m.SYS_NAME.includes('<name>')))"` → `false`
against a non-zero `grep -c <name> docs/ABI.md`: `sigprocmask`, `fcntl`, `realpath`,
`clock_gettime`, `env_get`, `env_set`, `notify`, `random`, `utimes`, `exec`. Eight of them are
recorded as owed nowhere — the two that are not are `utimes` (`src/bin/touch.mjs:3-8`) and `exec`
(`docs/CONSTRAINTS.md:1113`).

Three absences *are* recorded honestly, and they set the bar:
`mount`/`umount` as design (`docs/ABI.md:137-142`), `utimes` in `src/bin/touch.mjs:3-8`, the wheel
event in `MILESTONES.md`.

### A12 — a cursor selector

A sixth `win_set` selector, taking a closed, dense `WCUR_*` enum: arrow, text, hand, wait, and the
four resize axes. Validated by the kernel, rendered by the page — the same shape `WICON_*` already
uses, with a `selfTest` asserting the table is covered (`src/wm/icons.mjs:307`, which **MUST
actually be called**; it is exported and invoked by nothing, where `src/abi.mjs:2371` and
`src/kernel/trace.mjs:166` call theirs at module load).

**An arbitrary CSS cursor string MUST NOT be accepted from a process.** It hands a program a styling
capability, and it permits `cursor: none` — a window that hides the pointer over the whole desktop.

### A13 — a change notification

A watch on a directory fd, delivered through the readiness a process is already parked on. Shape is
undecided, and two things are fixed. It MUST be O(interested), never O(N) — constraint 18, 378 µs
per live worker round-trip. And **the directory-fd `poll` answer MUST be corrected first**:
`src/kernel/calls.mjs:1330-1332` reports `POLLIN|POLLOUT` for any directory fd, so a program that
built a watch on `poll(dirfd, POLLIN, -1)` never parks and spins a syscall loop at full rate. The
precedent is two branches above it — `F_DATA` returns `POLLNVAL` (`src/kernel/calls.mjs:1319-1329`)
expressly because the always-ready fallback made a poll-then-read loop spin.

### A14 — the substitute-chord table

One definition in `src/abi.mjs` or `src/libos/std.mjs`, read by the menus, the help and the
dispatcher, mapping each Windows 7 accelerator to the chord this system actually receives. Required
because the host reserves several of them (§7). Silently doing nothing on Alt+F4 is worse than the
action being bound elsewhere, and a menu that shows an accelerator the system cannot receive is the
live-looking-button defect M11 already recorded.

---

## 7. Out of scope, and what is impossible

### Explicitly out of scope

- **Libraries** (Documents, Pictures, Music, Videos as aggregated locations). They are the headline
  Explorer feature of Windows 7 and a pure userland convention over several real directories; they
  add no primitive and would be built on R5 and R27. Deferred until navigation and view modes exist.
- **Network locations, a browser, mail, an updater.** No process can reach any URL and that is a
  recorded position, not a gap to paper over (`docs/LEARNING-MODE.md:52-54`). The only network path
  is kernel-side, through the committed provider table (`src/kernel/providers.mjs`), whose discipline
  exists because a caller-supplied URL would hand every process an SSRF primitive.
- **Control Panel and Personalization.** The glass colour and blur deviation can be driven as live
  values, but `WIN_CAP_H` and `WIN_INSET` are terms in the kernel's blur accounting (D37,
  `src/abi.mjs:741-743`), so a theme that changes them MUST change them through the one definition
  both sides import. That is a design question of its own.
- **Installing or deleting a program.** `/usr` is `EROFS` and its contents are a frozen array read
  in full at boot (`src/kernel/providerfs.mjs:28-99`, `:133-145`, `:180`).
- **A per-process memory column in Task Manager.** Not a shortfall — see below.
- **CPU %, priority, a scheduler.** Constraint 21: there is no preemption. A process is killable and
  not interruptible, and `src/bin/taskmgr.mjs:266` already says what its one timing column means.

### Impossible in a browser, and never to be promised

- **Dragging a file out to the host desktop**, in portable form. Only Chromium supports the
  download-URL drag type. Dragging files *in* through the browser's own drop event is feasible.
- **Handing a file to a host application.** There is no such channel.
- **Several Windows 7 accelerators.** A page cannot intercept Ctrl+Shift+Esc or Win+L; the Win key
  is consumed by the host window manager on Windows and Linux; Alt+F4 closes the browser; Alt alone
  focuses Firefox's menu bar. Alt+Tab, F2, F5 (with `preventDefault`), Delete and the Ctrl chords are
  reachable. Hence A14.
- **A per-process memory figure.** `performance.measureUserAgentSpecificMemory` is per agent
  cluster, so it reports one number for every Worker together; attributing it to whichever process
  asked is worse than nothing. Already recorded in `MILESTONES.md`.
- **Reading the host clipboard without a gesture.** A bridge MUST be gesture-driven and MUST fail
  loudly rather than return empty bytes.
- **Suspending a compute-bound process.** A process issuing syscalls can be stopped by withholding
  the reply; one spinning in a loop cannot (constraint 21).
- **Raw sockets, listening sockets, real TCP.** The browser is the NIC.

---

## 8. How each requirement will be proven

CLAUDE.md's rules apply in full and are not restated: every check registers in `scripts/check.py`
through the one decorator, declares its label inventory, carries a floor in
`scripts/check_floors.json`, declares at least one negative control that breaks **the thing the
check is about** and is re-runnable as `--negative <name>` rather than a source edit, and inverts
under `--prove-failure`. A control must move a **named** subset of expectations. A window manager
cannot be checked by screenshot — drive real input and read the geometry back.

**Two harness gaps MUST be closed before any of this can be proven, and they are the reason all
four bugs shipped green.**

- **The driver cannot dispatch a wheel.** `_perform_gesture` (`scripts/check.py:1958-2026`) knows
  drag, press, move, release, click, rightclick, dblclick, hover, key and type, and raises
  `Unmeasurable` at `:2026` for anything else; `scripts/bidi.py:195-232` is pointerMove/Down/Up,
  pause, keyDown/Up. A `wheel` kind MUST be added to both, or R3 is unmeasurable by construction.
- **M15 is outside the registry.** `grep -ci m15 scripts/check.py` → 0, and there is no `m15` floor.
  The work in this PRD lands on top of uncovered code unless a registration lands with it.
  `audit()` has no rule demanding that a milestone or a page **have** a check
  (`scripts/check.py:1014-1201`), which is how that happened; adding one is cheap and belongs here.

**And one instrument MUST be chosen correctly, or two proofs below are inert.** `dropped`
increments only on a full ring (`src/kernel/wins.mjs:298-301`), so no stream a draining program
keeps up with ever moves it. Coalescing is asserted on `queued:` (`src/kernel/procfs.mjs:99`) and a
new `coalesced:` beside it. A `dropped == 0` clause and a control that breaks the coalescing would
both pass, which is a check coupled to nothing.

**And the wheel stream MUST be driven against a program that is not draining.** A1's argument is
that an uncoalesced stream laps the queue and the record `push` discards is the newest
(`src/kernel/wins.mjs:298-301`) — the reader's latest notch. A 200-notch stream into a 256-record
ring that a polling program is draining never reaches that state, so a control over it could not
turn the clause the argument is about, and the earlier draft asserted a scroll direction no control
could move. So the proof holds the program in a declared `--no-drain` mode and sends **300**
notches: coalesced they fold into one tail record, uncoalesced they fill the ring at 256 and drop
the last 44. The assertable consequence is the **offset** — coalesced, the program's offset after
the stream is the full summed delta; uncoalesced it is short by the most recent motion, which is why
the list stops following the hand and reverses on a direction change. One control, two clauses, both
turnable.

| Group | Check | Negative control |
| --- | --- | --- |
| R1, R2, R34 (the resize) | A new registered check drives a **real resize grip** with `Input.dispatchMouseEvent` — the first thing in this project ever to do so — then asserts `surface.el.getBoundingClientRect()` equals `bodyEl.clientWidth`/`clientHeight` **to within 1 CSS px** (the content box, not the border box: `border-top: 1px` makes the bounding rect 1 px taller, §2) **and** that `surface.w`/`surface.h` changed **in device px**, at four frame sizes including both extremes (CLAUDE.md: a layout is verified at its narrow and wide extremes, not one). **The tolerance is not slack and MUST NOT be tightened to equality**: `getBoundingClientRect` returns fractional CSS px (a `DOMRect` of doubles, <https://drafts.fxtf.org/geometry/#dom-domrect>) and `clientWidth`/`clientHeight` are rounded to integers (<https://drafts.csswg.org/cssom-view/#dom-element-clientwidth>), so an exact comparison fails on a fractional layout for a reason that is not a defect — and a frame at dpr 1 in Firefox is where it would fail first. The device-px clause stays exact, because both of its sides are integers. A third clause asserts the row count the program drew **grew**: equal geometry with a frozen backing store is the bug, and only the third clause separates them. A fourth, for R34, asserts `imgview`'s drawn pixel extent differs at two client sizes and reads back as flat blocks. | `--negative no-surface-fill` disables the renderer's sizing through a declared control flag, and the geometry clause MUST fail while the row-count clause holds. `--negative frozen-surface` makes the program skip its re-surface through its own argv flag, and the row-count clause MUST fail while the geometry clause holds. Two controls because there are two independent causes, and one control satisfied by either would verify neither. |
| R3, R20 (scroll and clip) | A driven wheel over a directory of 40 entries, asserting the row at the viewport top changed, that the header is still drawn (a pixel read, since an unclipped row paints over it), and that the offset clamps at both ends — both edges, per CLAUDE.md. Then a **300-notch stream into a program that is not draining**, held in a declared `--no-drain` mode: `queued:` is 1, `coalesced:` is 299, `dropped:` is 0, and the offset the program reaches afterwards equals the **full** summed delta. The stream exceeds `WIN_EVENT_CAP` 256 (`src/abi.mjs:477`) on purpose — see below. | `--negative no-clip` drops the clip op: the header clause MUST fail and the offset clauses MUST hold. `--negative unclamped-scroll` removes the end clamp: the clamp clauses MUST fail alone. `--negative no-wheel-coalesce` appends instead of summing into the tail: `queued:` MUST reach 300, `coalesced:` MUST stay 0, `dropped:` MUST reach 44, and the full-delta clause MUST fail. |
| R4, R5 (open and navigate) | A driven **double-click** on a directory row, asserting the window re-listed (its row set changed) and the title names the child; then on a file row, asserting a new pid appeared in `/proc` running the expected program. Enter does the same from the keyboard — but **Enter does not prove A3**, because it already arrives as byte 10 (`src/wm/terminal.mjs:29`). The clause that proves A3 is a driven **Down arrow** moving the focus and then Enter opening the row the arrow reached: an arrow is `null` from `bytesForKey` today and reaches no process. | `--negative one-click-opens` sets the click count on every DOWN: a single click MUST open, so the "a single click only selects" clause MUST fail. `--negative no-handler-table` empties the association: the spawn clause MUST fail by name with the refusal counted, not silently. |
| R6, R12, R13 (keyboard and selection) | Driven arrows walk the focus, Shift+click selects a range in **layout** order, Ctrl+click toggles, and a driven rubber band from empty space selects by intersection while a press on a row starts a drag instead. The arbitration is the assertion. | `--negative keysym-as-byte` has the page send a keysym as a byte: the arrow clauses MUST fail and the printable clauses MUST hold. `--negative band-from-row` starts a band on a row: the drag clause MUST fail. |
| R7 (Details and sort) | A header click sorts, a second reverses, directories stay first, and a folder's Size cell is empty while its Date cell is not — the second half is what proves the directory `stat` is paid, since nothing pays it today. Asserted on the **display list the page replayed**, read back through `textOfOps`, which is the first registered assertion over a text op — `grep -c DL_TEXT scripts/check.py` is 0. | `--negative stable-sort-off` drops the name secondary key: the order clause MUST fail. `--negative folders-last` inverts the primary key: the directories-first clause MUST fail alone. `--negative no-dir-stat` restores the `if (!dir)` guard: the folder-Date clause MUST fail alone. |
| R8, R16 (menus) | A driven right-click raises **this** system's menu: assert a `win_menu` reached the kernel and that `defaultPrevented` is true on the browser event. A second clause activates a row and reads the `WEV_ITEM` back; a third presses Esc and asserts the dismissal was reported. | `--negative no-menu-guard` removes the `contextmenu` listener and the `defaultPrevented` clause MUST fail. `--negative silent-dismiss` swallows the dismissal report and the third clause MUST fail alone. |
| R11 (hover) | A driven buttonless move changes the lit row, a `pointerleave` clears it, and `queued:` plus `coalesced:` show the stream was **replaced** rather than appended — a raw hover stream must not be able to lap a 256-record queue. | `--negative no-hover-coalesce` appends instead of replacing: `queued:` MUST rise to the sample count and `coalesced:` MUST stay 0, and the coalescing clause MUST fail while the lit-row clause holds. |
| R14, R15, R17, R18 (mutations, trash, clipboard, drag) | Each verb asserts the **filesystem**, not the drawing: a created directory appears in a fresh `readdir`, a rename moves the inode, a delete leaves the bytes reachable from the Bin and a restore returns them, a paste produces equal bytes, and a cross-window drag with Ctrl held reports `DOBJ_EFFECT_COPY` with the source still present. Each refusal's errno is asserted **separately** — a single "it refused" passes for a filesystem that refused for the wrong reason, which is how M3's `truncate` answered ENOENT where it owed EROFS. | `--negative restore-overwrites` lets a restore clobber an occupied path: the refusal clause MUST fail. `--negative move-forced-copy` ignores the modifier: the effect clause MUST fail alone. |
| R19 (refresh) | F5 re-lists and the selection survives for the rows that survive. | `--negative stale-listing` serves the cached rows: the content clause MUST fail. R32's live update is not scheduled, so neither it nor its control is owed yet — `docs/PLAN-SHELL.md` §6 carries why, and the directory-fd `poll` correction it depends on goes with it. |
| R26 (thumbnails) | A blit of a known bitmap, read back with `surface.pixel` in the shape `pixelColor` renders an asked-for colour into (constraint 224), plus the refusal path: a short payload and a wrong fd kind each assert their own errno. | `--negative blit-unvalidated` accepts a short payload: the errno clauses MUST fail, and the drawn-pixel clause MUST hold, so the control is scoped to validation alone. |
| R10, A2b, A12 and every other one-line correction | Each becomes a clause in an existing check, per CLAUDE.md: a fixed bug MUST become a check that would have caught it. `taskmgr`'s row selection is driven at a y whose `0x10` bit is **clear** — the exact input the pre-`de8a68a` code dropped — and the clause is a **registration** of the cases `bench/m14-shell/taskmgr.py` already drives, which the suite does not run. A2b asserts `/proc`'s `box:` **mid-drag**, with the pointer released outside the frame, which is the Firefox-capture case. `selfTest` in `src/wm/icons.mjs` MUST be called at module load, like `src/abi.mjs:2371`'s and `src/kernel/trace.mjs:166`'s. | For `taskmgr`, `--negative ev-b-pointer` restores the `ev.b` test and the clause MUST fail. For A2b, `--negative report-on-release` restores the release-only report and the mid-drag clause MUST fail. |
| Everything, in a second engine | `bench/m14-shell/firefox-drive.py` gains the file-manager gestures over `scripts/bidi.py`'s trusted input. Non-negotiable: the suite drives Chrome only, and that has now cost **four** milestones — M4a shipped a window that could not be dragged in Firefox, M6 shipped a policy under which no process started there, M11's blur band was placed at a constant pixel offset, M12's budget figure was a dpr-2 number. All four were green. **And §2's unit defect is dpr-shaped**, so every size clause above MUST be asserted at dpr 1 and dpr 2. | The existing `--prove-failure` in that driver. |

One rule governs the whole table. **Inversion alone does not prove a check is coupled to its
subject** — an assertion over a constant still inverts and still fires — so every group above
declares a control that breaks the subject, and the resize group declares two because the defect has
two independent causes.

---

## 9. Constraints this work falsifies

Two constraints say the opposite of a requirement here. CLAUDE.md's rule is that a falsified
constraint is updated, the evidence cited and the correction noted — never routed around. Each
amendment is a **deliverable** of the milestone that earns it (`docs/PLAN-SHELL.md` M17 and M19), and
neither is written before the evidence exists.

- **223** — "A POINTER EVENT IS A WINDOW EVENT, IN SURFACE PIXELS, AND A HOVER IS NOT SENT", on the
  argument that "a second of hovering would overflow a queue the process is being asked to drain".
  R11 and A5 reverse it, and the constraint's own last sentence licenses that: "A program that needs
  hover can ask for it when there is a program that needs hover." The evidence the amendment rests
  on is the tail-replacement coalescing and the measured `queued:`/`coalesced:` figures after a
  500-move stream — not the reversal itself, and not an argument.
- **294** — "A LIST VIEW WITH NO WHEEL EVENT MUST STATE ITS OVERFLOW, NOT GROW", on the premise that
  "the window ABI delivers `WPTR_DOWN`, `WPTR_UP` and `WPTR_MOVE` and no wheel, so a scrollbar would
  be a control the program cannot receive input for". R3 removes the premise. The amendment records
  that the cap was correct for the ABI as it stood and names the driven-wheel check as what replaced
  it. Its second half — the type column must carry information — is untouched.

---

## 10. Decisions this document does not take

Three need a human, and no measurement decides them.

1. **What Delete does on a read-only mount.** Constraint 28's honest degraded mount means a volume
   can be mounted `EROFS` after a bad superblock. Refusing by name is the safe default; greying the
   verb is the Windows 7 behaviour. R14 and R15 both ride on the answer.
2. **Where persisted shell configuration lives.** R24's pin list and R27's per-folder view state need
   a durable home and a format. `/desktop` on the root volume exists (`src/bin/desktop.mjs:36`) and
   is user data, not configuration; there is no `/etc`, and creating one introduces this system's
   first persisted configuration format.
3. **Which chord substitutes for Alt+Tab (R22).** Alt+Tab itself is interceptable in a tab, and it
   is also the host's switcher on every platform, so taking it has a cost.
   `bench/m22-switch/probe.py` prices the candidates by reporting which are free in each engine; the
   choice among the free ones is a human's.

Every other question in this area is **decided** in `docs/PLAN-SHELL.md` §7, which states each
decision, its reason and its cost — so it is not also listed as open here.

### What `queued:` counts, measured

`Window.push` does `this.stats.queued += 1` at `src/kernel/wins.mjs:278`, **above** the ring-full
drop at `:298-301`. So `queued:` counts events **OFFERED**, not events that entered the ring, and
`queued === delivered + dropped + pending` is the identity it participates in. Three rounds of
review stated it the other way; the figures below are the corrected ones.

For a 300-notch stream into a non-draining program:

| | `queued:` | `coalesced:` | `dropped:` |
| --- | --- | --- | --- |
| coalescing on | 1 | 299 | 0 |
| coalescing off | 300 | 0 | 44 |

`queued:` is 300 and not 256 with coalescing off, because an offer that the ring refuses is still
an offer. `dropped:` 44 = 300 − 256 is the ring's own ceiling (`WIN_EVENT_CAP`, `src/abi.mjs:477`)
and is the secondary instrument; the primary pair is `queued:`/`coalesced:`.

## Residual — what three review rounds did not settle

This document went through an adversarial critic, a correction pass, and a second verification.
Each round found fewer and smaller things; these are what the third round left open, recorded here
rather than silently carried. **None of them blocks M16**, which is the only milestone specified to
implementable detail.

1. **The scroll offset's unit, and the wheel delta's.** A scroll offset is the program's own and a
   wheel delta is the device's; the documents name surface px for both and have not shown that the
   conversion belongs at the event rather than in each program. Settle it when A1 is written, with
   one named conversion site, the way `rowAt` has one.
2. **`taskmgr`'s layout constants are surface px under a CSS-px premise.** §4.8's rule covers
   `files`; `src/bin/taskmgr.mjs`'s `COLUMNS` x-values were written against the surface it asks
   for. They need the same treatment and are not in M16's named program list.
3. **R34 has no implementable detail.** Its assertion — drawn extent differs at two client sizes —
   bites only for a pair that straddles an integer `scale` boundary (`src/bin/imgview.mjs:134`),
   and no size pair is named. Name one before M16 is started, or the clause passes on a window
   whose image did not change.
4. **The hover and wheel coalescing numbers share one unproven assumption:** that the page
   coalesces before `push`, which is where A1 and A5 put it, but no measurement yet shows the
   browser delivers a 300-notch stream as 300 events rather than pre-coalescing them itself. Cheap
   to settle: `bench/m16-resize/probe.py` can count `wheel` events against notches driven.

The three build-breakers the rounds DID settle are worth stating, because they are what the review
bought: a dpr unit confusion under which M16's three clauses would all have passed over half-height
illegible rows; a `blurRingArea` self-test specified over `w = 0`, which fails (852 against 0); and
a coalescing control that could not turn its own clause.
