# PLAN — delivering the file manager and the shell

The engineering plan for `docs/PRD-SHELL.md`, from the state M15 left. It schedules; it does not
re-argue requirements. Requirements are cited as **R1**–**R34** and ABI additions as **A1**–**A14**
from that document. Constraints are cited by number from `docs/CONSTRAINTS.md`.

`PLAN.md` §8 is the rule this follows: the riskiest assumption is tested first, and that is the one
scheduling rule that matters. §1 names which assumption that is here, and it is not the one the
brief assumed.

**Units are the PRD's §2 and are not restated.** Every size below names its unit. The short form:
a frame's box and every `src/wm/aero.mjs` number are CSS px; `win_surface` and the surface budget
are device px; every display-list coordinate and a pointer event's `a`/`b` are **surface** px — the
process's own backing-store unit, which equals device px only when the surface is the full client
box; `WEV_RESIZE` is cells. The factor between CSS and device px is the dpr, and a process cannot
currently learn it.

---

## 1. The order, and why it is the order

### The brief's hypothesis, and where it is wrong

The brief proposed resizing a surface first, because "every surfaced program ignores `WEV_RESIZE`
today and the fix touches the kernel's surface accounting, the renderer, and every program at
once."

**The conclusion is right and all three reasons are false.** Each is measurable.

1. **The kernel's surface accounting needs no change.** `WinMgr.surface` already releases the held
   area before charging the new one — `const held = win.surface ? win.surface.w * win.surface.h :
   0;` then `this.stats.surfacePx += want - held;` (`src/kernel/wins.mjs:1040`, `:1047`) — and the
   docstring above it says why: "A second call RESIZES, which is what a window being dragged bigger
   needs" (`:1023`).
2. **The renderer needs no change.** `#surface` already destroys the old canvas and builds a new one
   on a second `win-surface`: `entry.surface.destroy(); entry.surface = null;`
   (`src/wm/winhost.mjs:507-508`), then `entry.surface = new Surface({...})` at `:520`.
3. **The programs are five files and one shared branch, not a design.**
   `grep -n "WEV_RESIZE || ev.type === WEV_FOCUS" src/bin/*.mjs` returns five hits —
   `desktop.mjs:361`, `files.mjs:439`, `editor.mjs:210`, `imgview.mjs:314`, `taskmgr.mjs:349`.
   **Three of the five are a bare `continue` and two are not**, and the distinction does not change
   the conclusion: `taskmgr:349` repaints at the size it already had, and `paint` — which that grep
   does **not** reach — has its own branch at `src/bin/paint.mjs:215` that counts the event and
   discards it, with a comment stating the discard is deliberate. So the shared branch is
   `files`/`editor`/`desktop` and two programs need their own edit. Five files either way.

Resizing a surface is **present but unreachable**, not missing. The risk is not in the product.

### Where the risk actually is

It is in the **proof**, and there are three unretired measurement assumptions. Any one failing
reorders this plan.

- **No check and no page has ever driven a resize grip.** `grep -rn grip scripts bench www` returns
  nothing. A grip calls `setPointerCapture` on the grip element and then runs the gesture on
  `document` listeners (`src/wm/window.mjs:762-772`, and the capture MAY THROW — constraint 175).
  Whether `Input.dispatchMouseEvent` drives that path is unmeasured.
- **No driver in either engine can dispatch a wheel.** `_perform_gesture`
  (`scripts/check.py:1958-2026`) ends with `raise Unmeasurable("the page asked for a %r gesture,
  which no driver here performs" % kind)` at `:2026`; `scripts/bidi.py:195-232` is
  pointerMove/Down/Up, pause, keyDown/Up. If CDP's `mouseWheel` does not reach a `wheel` listener on
  a canvas, **R3 is unmeasurable by construction** and A1's delivery route changes.
- **Every registered size clause runs at one dpr.** The PRD's §2 defect is dpr-shaped and its
  measurement table was taken at dpr 1 while the reference machine is dpr 2, so the figures
  understate the blur by 2× and the unit error is invisible in them. Whether the suite can be driven
  at a chosen `--force-device-scale-factor` and read back consistently is unmeasured, and M11 and
  M12 each cost a milestone to the same class of assumption (constraint 264).

So M0's discipline applies, and it applies to the **harness** rather than to the kernel. One
half-day probe answers all three before any code is written, and it is the first thing in this plan
after the gate.

**That is why resize is first.** Not because the fix is hard — it is five branches, one renderer
change and one unit conversion — but because its proof is the common dependency of everything after
it. R3's scroll, R7's columns, R14's inline rename and R27's view modes all assume a program
repaints at a new size in a known unit, and none of them is checkable until a grip can be driven and
a program obeys.

### And one thing goes before it, because it is the gate

**M15 shipped with zero registered checks and no floor.** `grep -ci m15 scripts/check.py` → 0, and
`scripts/check_floors.json` holds `"m13": 38` and `"m14": 57` and no `m15` key. `audit()` has no rule
demanding that a milestone **have** a check (`scripts/check.py:1014-1201`), which is how that
happened. Every milestone below lands on top of `src/bin/files.mjs` and `src/bin/taskmgr.mjs` —
1,000-odd lines with no registered assertion over them. The gate is half a day and it MUST land
first, because without the `audit()` rule the registration does not prevent the next recurrence.

---

## 2. The milestones

Ten, M15a through M23, plus **M19a inserted** between M19 and M20 once the PRD's §10.1 was answered
(D40). **23 days estimated**, and the inserted row's half-day is not in that figure. This project's
history runs under estimate by 2–4×
(M1 est 4 / actual 1; M2 est 8 / actual 3; M13 est 5 / actual 0.5), so the figure is an upper bound
rather than a forecast — but the estimates are stated at the bar the earlier rows were estimated at,
so the record stays comparable.

Every row owes what CLAUDE.md requires and it is not restated per row: a registration through the
one decorator, a label inventory, a committed floor, at least one negative control that breaks **the
thing the check is about** and is re-runnable as `--negative <name>` rather than a source edit,
inversion under `--prove-failure`, and a second engine before the row is reported done.

**ABI numbers are assigned here and nowhere else**, in landing order, because that is the only order
in which a dense table stays dense. `docs/PRD-SHELL.md` §6 assigns none, and fixes the field layout
and the free space instead.

---

### M15a — the registration debt, and the rule that stops it recurring · 0.5 d · DONE

**Closes.** M15's absence from the registry. Nothing in the product.

**ABI.** None.

**Programs.** None. `scripts/check.py`, `scripts/check_floors.json`.

**Proof.** A `check_m15` over what M15 shipped: the twelve coreutils at a real prompt (the cases
already exist in `bench/m14-shell/coreutils.py`), a `DL_TEXT` run read back through `textOfOps` —
which would be the first registered assertion over the text op, since `grep -c DL_TEXT
scripts/check.py` is 0 — and the hover flyout's grace period (constraint 295). Plus a new `audit()`
rule: every milestone named in `MILESTONES.md`'s status table MUST have a registered check or a
declared reason, read the way `no_invert_reason` is read today.

**Negative controls.** `--negative no-hover-grace` restores the instant `pointerleave` close, which
is the defect constraint 295 records; the flyout clause MUST fail and the coreutils clauses MUST
hold.

For the `audit()` rule the control is NOT "the rule firing on a deleted registration" — that is a
source edit nobody re-runs, and it certifies itself. The rule takes its registry and its milestone
list as **arguments**, so `--negative milestone-unchecked` runs `audit()` over a committed fixture
whose milestone list carries one row no check claims, and the run MUST raise `RegistryError`. A rule
that cannot be shown to refuse is a rule nobody has seen work.

**If the assumption is wrong.** The assumption is that M15's behaviour is assertable from the
existing bench scripts. If the coreutils cases turn out to need a pty the registered harness cannot
reach, the row shrinks to the `audit()` rule plus a declared reason, and the bench stays the only
gate — which is worse but honest, and the reason is readable.

---

### M16 — the client box IS the surface, in device pixels · 2 d + 0.5 d probe · DONE

**Closes.** R1, R2, R8, R10, R34, A2, A2b, A2c, A2d. The reader's bugs 2 and 4 — all three of bug
4's causes — and the two transcription defects the audit found beside them.

**ABI.** `WEV_CLIENT: 13`, `WEV_MAX: 13`, `clientBoxAt(ev)`. Additive; no record widens. `a` and `b`
are the client **content** box in **device pixels**, `c` is the dpr in 16.16 fixed point.

**Programs.** All five surfaced programs: `files`, `editor`, `imgview`, `paint`, `taskmgr`, through
one shared helper in `src/libos/std.mjs`. **`paint` and `taskmgr` each have their own existing
branch** (`src/bin/paint.mjs:215`, `src/bin/taskmgr.mjs:349`) rather than the shared
`WEV_RESIZE || WEV_FOCUS` discard, so each takes its own edit. Plus R10's **registration** — the
code fix landed in `de8a68a` and `src/bin/taskmgr.mjs:341` already reads `ev.mods`; what is owed is
the check, since `grep -n taskmgr scripts/check.py` is empty and `bench/m14-shell/taskmgr.py` is a
bench the suite does not run.

**Deliverable beyond code.** None of this amends a constraint. It does add **proposed D40** (§4.4)
and it makes constraint 49's accounting readable from `/proc` for the first time.

**Proof.** A new `check_m16` drives a **real resize grip** with `Input.dispatchMouseEvent` — the
first thing in this project ever to do so — and asserts four separable things at four frame sizes
including both extremes (a layout is verified at its narrow and wide extremes, not one), **at dpr 1
and at dpr 2**:
(a) `surface.el.getBoundingClientRect()` equals `bodyEl.clientWidth`/`clientHeight` **to within
1 CSS px** — the **content** box, because `border-top: 1px` (`src/wm/aero.mjs:406`) makes the body's
bounding rect 1 px taller than the box the canvas fills. **The tolerance is required and MUST NOT be
tightened to equality**: a `DOMRect`'s fields are doubles
(<https://drafts.fxtf.org/geometry/#dom-domrect>) and `clientWidth`/`clientHeight` are rounded to
integers (<https://drafts.csswg.org/cssom-view/#dom-element-clientwidth>), so the two differ by up
to a pixel on any fractional layout — and this clause also runs in Firefox at dpr 1, where it would
fail for a reason that is not a defect;
(b) `surface.w`/`surface.h` **changed** and equal that content box × dpr, read off `WinHost`;
(c) the row count the program drew **grew**, read back through `textOfOps`;
(d) `imgview`'s drawn pixel extent differs at two client sizes and reads back as flat colour blocks,
which is R34 — a CSS-scaled canvas reads back as the old extent with interpolated edges.
Equal geometry over a frozen backing store is the bug, and only (c) separates them; equal geometry
at the wrong dpr is the unit bug, and only (b) separates that.
A fifth clause reads `/proc/<pid>/win/<winid>`'s new `client:` and `dpr:` lines **mid-drag**, with
the pointer released outside the frame — the Firefox-capture case (constraint 175). A sixth asserts
`defaultPrevented` on a right-click inside a surface. A seventh drives `taskmgr`'s row selection at
five heights including a y whose `0x10` bit is **clear**, which is the exact input the
pre-`de8a68a` code dropped; five and not one because the old failure was periodic in y, so one row
would have passed by luck — the cases are `bench/m14-shell/taskmgr.py`'s and this clause registers
them.

**Negative controls.** Four, because the defect has four independent causes and a control satisfied
by any of them would verify none. Each is a declared flag, re-runnable, not a source mutation.
- `no-surface-fill` disables `Surface`'s own sizing (§4.4): clause (a) MUST fail, (b), (c) and (d)
  MUST hold.
- `frozen-surface` makes the program skip its re-surface: (b), (c) and (d) MUST fail, (a) MUST hold.
- `css-px-surface` has the program pass its CSS-px constants to `win_surface` unscaled, which is
  today's behaviour: (b) MUST fail at dpr 2 and MUST **hold** at dpr 1, which is the clause that
  proves the suite can see a unit error at all.
- `report-on-release` restores the release-only `win-geom`: the mid-drag clause MUST fail alone.
- `ev-b-pointer` restores `taskmgr`'s pre-`de8a68a` `ev.b` test: the selection clause MUST fail
  alone. This is the one control here whose subject is a defect already fixed, which is what makes
  it a genuine negative control rather than a source mutation — it puts committed code back into
  the state a reader hit.

**If the assumption is wrong.** The assumption is that a grip is drivable by CDP. If it is not, R1's
geometry clause survives (a `WIN_SET_BOX` from a process reaches the same `apply()` path and needs no
grip) but R2's and A2b's mid-drag clauses do not, and the mid-drag report becomes assertable only in
Firefox through `scripts/bidi.py`'s trusted input. That reorders nothing below it; it moves one
clause to a second driver and the row says so.

---

### M17 — the wheel, the clip, and a list that scrolls · 2 d · DONE

**Shipped.** What landed is in `MILESTONES.md` §M17: three driven proofs at 35 expectations, the
two transport facts measured first (constraints 297 and 298), and **two of the three controls named
below registered as UNMEASURABLE with the address of what they would need**, because no world in
`src/` selects them. The specification below is unedited — it is what was asked for, and the
tracker is what was delivered.

**Closes.** R3, R20, A1, A6.

**ABI.** `WEV_WHEEL: 14`, `WEV_MAX: 14`, `WWHEEL_PAGE: 0x400`, `WWHEEL_COALESCED: 0x800`,
`wheelAt(ev)` (the sign restored, for constraint 225's reason). `DL_CLIP: 7`, `DL_MAX: 7`, with
flags bit 1 meaning reset.

**Both units, named on the right thing.** `WEV_WHEEL`'s `a`/`b` are **surface px** for a surfaced
window and **cells** for a text one — the two units `WEV_POINTER` and `WEV_RESIZE` already use
(constraint 248) — and its `c` is the pointer position in the same unit. `DL_CLIP`'s `a0..a3` are
**surface px**, like every other display-list coordinate. Neither is device px: that is
`win_surface`'s unit and nothing else's (PRD §2).

**The wheel bits are 0x400 and 0x800 and not 0x8 and 0x80**, because `mods` is one namespace shared
by every event type (PRD §6): `0x8` is `WMOD_META`, reserved on every type, and `0x80` is A4's
`WPTR_CLICK2`. One self-test clause MUST assert the whole allocation is pairwise disjoint and
single-bit — `src/abi.mjs:2145` does that for the three pointer bits and `:2152`/`:2322` for the
modifiers, **separately**, which is how two sub-tables could overlap at all.

**Programs.** `files` and `taskmgr` gain a scroll offset and a clipped viewport; both currently cap
and state the overflow (`src/bin/files.mjs:228`, constraint 294). `files` also gains a declared
`--no-drain` argv flag that holds its event loop for a stated number of milliseconds — not a
control, a **fixture**: the lapping clause needs a window that is not being read, and the precedent
for a shipped flag whose only job is to put the system in a state a check needs is
`cfg.blurBudgetPx` (`src/kernel/wins.mjs:1077`) and `scripts/serve.py --no-isolation`.

**Deliverable beyond code: constraint 294 is amended.** It is normative and it says the opposite of
R3 — "the window ABI delivers `WPTR_DOWN`, `WPTR_UP` and `WPTR_MOVE` and no wheel, so a scrollbar
would be a control the program cannot receive input for". This row removes the premise, so the
constraint is updated in the same change, citing the driven-wheel check as the evidence and recording
that the cap was correct for the ABI as it stood. Its second half — a type column must carry
information — is untouched. CLAUDE.md: a falsified constraint is updated, cited and noted, never
routed around.

**Proof.** A driven wheel over a directory of 40 entries: the row at the viewport top changed, the
header is **still drawn** (a pixel read, because an unclipped row paints over it), and the offset
clamps at both ends. Coalescing is asserted on **`queued:`** (`src/kernel/procfs.mjs:99`) and a new
**`coalesced:`** beside it, over a **300-notch stream into a program held in a declared `--no-drain`
mode**: `queued:` is 1, `coalesced:` is 299, `dropped:` is 0, and the offset the program reaches on
resuming equals the **full** summed delta.

**The stream must exceed `WIN_EVENT_CAP` and the program must not drain, or the control below
cannot turn the clause it claims.** A1's argument is that an uncoalesced stream laps the ring and
`push` discards the **newest** record (`src/kernel/wins.mjs:298-301`) — the reader's latest notch.
`WIN_EVENT_CAP` is 256 (`src/abi.mjs:477`), so a 200-notch stream into a ring that a polling program
is draining never reaches that state: nothing is dropped whether or not the kernel coalesced, and an
earlier draft of this row asserted a scroll direction no control could move. 300 notches against a
non-draining program is the smallest stream that reaches it. `dropped:` is therefore a **second**
instrument here and not the primary one — `queued:` and `coalesced:` carry the coalescing, and
`dropped:` carries the lapping.

**Negative controls.** `no-clip` drops the `DL_CLIP` op: the header clause MUST fail, the clamp
clauses MUST hold. `unclamped-scroll` removes the end clamp: the clamp clauses MUST fail alone.
`no-wheel-coalesce` appends instead of summing into the tail: against the same non-draining
300-notch stream, `queued:` MUST reach 300, `coalesced:` MUST stay 0, `dropped:` MUST reach 44, and
the full-delta clause MUST fail — the offset falls short by the most recent motion, which is why the
list stops following the reader's hand and moves the wrong way on a direction change.

> **CORRECTION, from the implementation.** Two sentences above this one are wrong, and the run that
> found each is named beside it. The specification is left as written and corrected here rather than
> edited, which is this repo's rule for a falsified claim.
>
> 1. **The full-delta clause does not fail under `no-wheel-coalesce`, and cannot.**
>    `account.dyTotal` is summed inside `scrollBy`, so it totals the deltas the program RECEIVED;
>    `scroll == dyTotal` therefore survives any number of records the kernel discarded.
>    `every notch reached the program` is the clause that catches dropping, because it compares
>    against what the PAGE sent, and it does go red. Measured by
>    `scripts/check.py --negative no-wheel-coalesce`: 6 red / 29 intact.
> 2. **`dropped:` reaches 47, not 44**, because three notches were already queued when the stream
>    started. The DELTA is 44 as predicted; the absolute figure is three higher.
> 3. **`unclamped-scroll` must remove the END clamp only.** Removing both edges also turns the
>    magnitude clause — the page establishes it by scrolling back to the top and measuring a known
>    delta from there, which a list with no top cannot do. "The clamp clauses MUST fail alone" is
>    true of the narrower world and false of the wider one; `Expect(failed=..)` refused the wider.

**The forged-event guard lands here, and it covers M16's event too.** PRD §6 carries the rule:
`WEV_CLIENT` joins `WinMgr.feed`'s refusal (`src/kernel/wins.mjs:1454-1457`,
`stats.forgedKernelEvents`), `WEV_WHEEL` does not, and `feed` masks `WWHEEL_COALESCED` out of any
wheel record it accepts. It is scheduled in this row rather than M16 because both halves are one
edit to one function, and M16 declares that it does not claim it.

**If the assumption is wrong.** The assumption is CDP `mouseWheel` → a `wheel` listener. If the probe
says no, A1 still lands and is proven in Firefox only; the Chrome suite asserts the coalescing
arithmetic under node (`bench/m17-wheel/probe.mjs`) and declares the delivery clause unmeasurable
with a reason, which is what `requires_isolation` already models for a SAB.

**One thing the kernel owes here that the PRD does not say.** A2b makes the client box change **per
animation frame** during a drag, so `WEV_CLIENT` must coalesce by **replacing** the tail record — a
stale size has no history worth keeping, unlike a drag sample. At 120 Hz over a two-second drag an
appending client event is 240 records against `WIN_EVENT_CAP` 256. And the program must NOT
re-surface per frame: one re-surface per drained batch is both the cheap answer and the faithful one,
because a CSS-stretched canvas during the gesture is exactly what Windows 7 shows while a window is
being dragged bigger.

---

### M18 — keys that are not bytes, and a row that opens · 2.5 d · DONE

**Closes.** R4, R5, R6, R9, A3, A4.

**ABI.** A dense `WKEY_*` table — four arrows, Home, End, PageUp, PageDown, Delete, Insert, F1–F12,
Menu — delivered as `WEV_KEY` with `a == 0` and the keysym in `c`. `WMOD_META: 0x8`.
`WPTR_CLICK2: 0x80` and `WPTR_CLICK3: 0x100` on the DOWN record, from `event.detail`. No new syscall.

**Programs.** `files` gains navigation and an activation verb; `src/libos/std.mjs` gains the
extension → program table moved out of `src/bin/desktop.mjs:76`. `src/bin/desktop.mjs` imports it
back. `editor` and `taskmgr` inherit arrow keys for free.

**Proof.** A driven **double-click** on a directory row: the window re-listed (its row set changed)
and the title names the child. On a file row: a new pid appeared in `/proc` running the expected
program. Enter from the keyboard does the same — but **Enter is not the clause that proves A3**:
`bytesForKey` already returns byte 10 for it (`src/wm/terminal.mjs:29`), so Enter reaches a process
today and asserting it would pass with A3 unimplemented. The A3 clause is a driven **Down arrow**
moving the focus, then Enter opening the row the arrow reached: an arrow is `null` from
`bytesForKey` and is dropped at `src/wm/winhost.mjs:599-600`. Alt+Left goes back; Backspace goes
back, because Windows 7 binds Backspace to Back and has no Up button.

**Negative controls.** `one-click-opens` sets the click count on every DOWN: the "a single click only
selects" clause MUST fail. `no-handler-table` empties the association: the spawn clause MUST fail **by
name**, with the refusal counted rather than silent. `keysym-as-byte` has the page send a keysym as a
byte: the arrow clauses MUST fail and the printable clauses MUST hold.

**If the assumption is wrong.** `a == 0` is the discriminator, and the assumption is that every
existing byte reader is unaffected. `keyBytesOf` returns an empty array for a length outside 1..4
(`src/abi.mjs:1428-1436`), so a program that does not know the table sees a key with no bytes. If any
caller in `src/bin/` treats an empty array as a printable key, the discriminator moves to a `mods`
bit instead — a half-day change, and `grep -rn keyBytesOf src/bin/` is the measurement.

> **CORRECTION, from the implementation.** The specification above is left as written and corrected
> here rather than edited, which is this repo's rule for a falsified claim. The assumption it names
> HELD — the grep was run first, eight call sites across seven programs, every one guards on length
> or decodes to a string, so the `mods`-bit fallback was never needed (constraint 299). Three other
> sentences did not.
>
> 1. **"`WPTR_CLICK2: 0x80` … from `event.detail`" is underspecified, and the obvious reading does
>    not work.** `detail` is 0 on `pointerdown` in BOTH engines; only `mousedown` carries the
>    platform's count. Measured by `bench/m18-keys/clickcount.py` — `pointerdown [0, 0]`,
>    `mousedown [1, 2]` on Firefox 156 and Chrome alike (constraint 300). The host reads it off a
>    `pointerdown` listener, so **no double-click reaches any program**, and the proof this row
>    specifies is 15 of 38 expectations red on the tree as it stands. The ABI and the program are
>    both correct; one listener is not.
> 2. **"`editor` and `taskmgr` inherit arrow keys for free" is true of the DELIVERY and false of the
>    behaviour.** Both now receive a keysym record, and neither binds one: `grep -rn keysymOf
>    src/bin/` names `src/bin/files.mjs` and nothing else. What they inherited is a key they can
>    read when someone writes the binding, which is M19's to do.
> 3. **"The arrows belong to the frame" is narrower than it was written.** `src/abi.mjs`'s keysym
>    comment and `src/bin/taskmgr.mjs:578` both say a process never sees an arrow because
>    `src/wm/window.mjs` binds it. That binding is on the TITLE BAR (`src/wm/window.mjs:286`,
>    `bar.addEventListener("keydown", …)`), not the frame, so a window whose SURFACE has focus
>    receives arrows — measured, in Chrome by `www/m18.html` proof 2 and in Firefox by
>    `bench/m18-keys/firefox-keys.py`, both of which move a cursor with a real Down arrow. The two
>    comments overstate it and are a later slice's to amend.

---

### M19 — Details, sort, selection, hover · 3 d · DONE

**Closes.** R7, R11, R12, R13, R20's measured half, A5, A8, A12.

**ABI.** `WPTR_LEAVE: 0x200`, and the removal of `if (!e.buttons) return;` (`src/wm/winhost.mjs:575`)
which is the one line making the documented hover case unreachable (`src/abi.mjs:463`).
`DLT_ELLIPSIS: 16`. `WIN_SET_CURSOR: 6` with a closed, dense `WCUR_*` enum. A generated `/dev` row
carrying per-family, per-size advance widths, built on `src/kernel/synth.mjs`'s adapter — **data, not
a measuring capability**, so constraint 41 and `src/libos/lockdown.mjs` are unchanged.

**The table's set of sizes MUST be declared in `src/abi.mjs`, because the renderer has none.**
`const size = Math.max(1, op.a2 | 0);` (`src/wm/surface.mjs:119`) accepts any positive i32, so "per
size the renderer offers" is not a closed set and a table indexed by it cannot be built. One declared
list, the renderer still accepting any size, and a size outside the list having **no row** — so a
program drawing at one lays out with `DLT_ELLIPSIS` alone rather than with a wrong advance. The size
is in **surface px**, which is the unit `a2` already is — `measureText` runs in the canvas's own
coordinate space, which is the backing store, so the table is indexed in the unit the op carries.

**Programs.** `files` gains four columns, a header click, an anchor-based selection and a rubber band,
and pays an `lstat` for **every** row: the call is inside `if (!dir)` today
(`src/bin/files.mjs:193-195`), so a folder's Date modified needs a call nothing currently pays, and
the dead `dir ? …` ternary at `:194` goes with it. `taskmgr` gains hover and the same selection
rules. `src/wm/icons.mjs`'s `selfTest` is **called** at module load — it is exported and invoked by
nothing (`:307`), where `src/abi.mjs:2371` and `src/kernel/trace.mjs:166` call theirs.

**Deliverable beyond code: constraint 223 is amended.** It says "A HOVER IS NOT SENT", on the
argument that "a second of hovering would overflow a queue the process is being asked to drain",
and A5 reverses it. Its own last sentence licenses that — "A program that needs hover can ask for it
when there is a program that needs hover" — but the amendment MUST rest on the measurement, not the
sentence: the tail-replacement coalescing and the `queued:`/`coalesced:` figures after a 500-move
stream. The constraint is updated with those figures cited, in this row.

**Proof.** A header click sorts, a second reverses, directories stay first, a folder's Size cell is
empty **and its Date cell is not** — the second half is what proves the directory `stat` is paid.
All asserted on the display list the page replayed, read back through `textOfOps`. A driven
buttonless move changes the lit row and a `pointerleave` clears it, with `queued:` and `coalesced:`
showing the stream was replaced rather than appended. Shift+click selects a range in **layout**
order; Ctrl+click toggles and moves the anchor; a band from empty space selects by intersection
while a press on a row starts a drag — the arbitration is the assertion.

**Negative controls.** `stable-sort-off` drops the name secondary key: the order clause MUST fail.
`folders-last` inverts the primary key: the directories-first clause MUST fail alone.
`no-dir-stat` restores the `if (!dir)` guard: the folder-Date clause MUST fail alone.
`no-hover-coalesce` appends instead of replacing: `queued:` MUST rise to the sample count and
`coalesced:` MUST stay 0, and the coalescing clause MUST fail while the lit-row clause holds —
`dropped:` is not used, for M17's reason.
`band-from-row` starts a band on a row: the drag clause MUST fail alone.

**If the assumption is wrong.** The assumption is that a published advance table is close enough to
the renderer's real font to lay out a column. The cheapest check is in §5. If it is not,
`DLT_ELLIPSIS` carries R20 alone — the renderer has the real font — and the column widths stay
proportional rather than fitted, which costs R30 and nothing in P0.

> **CORRECTION, from the implementation.** The specification above is left as written and corrected
> here rather than edited, which is this repo's rule for a falsified claim. **The assumption it
> names was HALF right, and the split is by font family rather than by degree.**
>
> 1. **The advance table is EXACT for a monospaced run and cannot be made exact for a proportional
>    one.** Measured by `bench/m19-advance/probe.py` in two engines at three ratios: a mono string's
>    width equals the sum of its published advances to **0.0000 px** over 2,448 samples (and over
>    1,152 more in a second sweep at 26–48 px), and a
>    proportional one is wrong by up to **13.2147 px** because the renderer kerns (constraint 302).
>    So the escape hatch this row wrote — "`DLT_ELLIPSIS` carries R20 alone … the column widths stay
>    proportional rather than fitted" — is the path M19 took for the three proportional columns, and
>    it is also not a loss: the error has ONE SIGN (`sum >= measured`, range
>    −13.2147..+0.0000 px), so a summed width is a strict UPPER bound and answers "will this
>    definitely fit?" exactly. R30 is deferred, as this row said it would be. **Nothing reads
>    `/dev/advance` yet**, deliberately.
> 2. **The table is ENGINE-shaped and not RATIO-shaped**, which is the opposite of what §5's
>    reasoning and this project's three previous unit bills predicted: **0.0000 px** within one
>    engine across dpr 1 / 1.5 / 2, against 0.4522 px across engines. That follows from the row's
>    own instruction to index it in SURFACE px, and it is the only reason one committed table serves
>    both engines.
> 3. **`src/wm/winhost.mjs:575` is a stale address.** The `if (!e.buttons) return;` this row names
>    was not at `:575` when the work started, and the line it refers to is now the hover branch at
>    `:807`. The `src/abi.mjs:463` reference is stale the same way. Addresses in this file are not
>    re-pinned by the implementation, so a reader should grep the quoted source rather than trust a
>    line number.
> 4. **`no-hover-coalesce` moves THREE clauses and not two.** This row predicts `queued:` rising and
>    `coalesced:` staying 0, which is exactly what the run measures — and a third clause goes red
>    with them: **`theProgramSawOneRecord`**, because a resumed program reading 40 appended records
>    where it should read 1 is the same defect seen from the program's side. Measured **4 red / 56
>    intact** including the page's own verdict. The lit-row clauses hold, as predicted.
> 5. **`src/wm/icons.mjs`'s `selfTest` was exported and called by nothing, as this row says, and it
>    is now called at module load** — `src/wm/icons.mjs:343`, not `:307`, which is the declaration.

---

### M19a — the session is a writable copy of the read-only base · 0.5 d · DONE

**AN INSERTED ROW, NOT IN THIS PLAN'S ORIGINAL ORDER.** It sits here because it answers the one
question this plan left to a human and M20 is the row that needed the answer.

**Closes.** The PRD's §10.1, and `docs/DECISIONS.md` D40 is where the answer is recorded.

**§10.1 IS ANSWERED, AND NOT WITH THE REFUSAL THIS PLAN EXPECTED.** M20's row below says that if
§10.1 is unresolved when the work starts, "Delete ships refusing by name and the refusal is
asserted." The owner's answer removes the case instead: *"i would like all operating systems to be a
copy of the read only base. then each session can be modified freely."* The base is copied once into
the writable journaled volume (`src/kernel/seed.mjs`, `/Users/Default`), the session works on the
copy, and **nothing a reader can reach is read-only** — so New folder, rename, Delete, Cut/Copy/Paste
need **no read-only case at all**. M20's refusal-by-name fallback is not needed and must not be
built: a branch for a world the product no longer has is a branch no check can reach.

The read-only mounts are unchanged. `/usr` is still `MNT_RO` with `mutErrno: "EROFS"`, still
reachable through `Computer` and `Programs`, and still refuses at two independent layers
(`src/kernel/calls.mjs:297` and `src/kernel/synth.mjs:192`). What changed is that it is no longer the
directory a reader lands in.

**The gate is constraint 28 at a new door**, and constraint 306 carries it:
`store.report.mountable === MOUNT_FRESH && store.mode === MOUNT_RW && !!store.vfs`. A second copy
over an edited tree is the defect 28 names. `scripts/check.py --negative reseed-always` is the world
that proves the gate holds.

**What M20 inherits.** `std.sessionDir(env)` in `src/libos/std.mjs` is the one definition of where a
program lands — `HOME_DIR` with `BASE_DIR = "/usr/share"` as the fallback and a `why` that is
non-empty exactly when the fallback was taken. `src/bin/files.mjs` with no operand and
`src/bin/desktop.mjs`'s folder row both read it; `DEFAULT_DIR` and `DESK_DIR` are gone. M20's verbs
run against whatever that function returns and must not restate a path.

---

### M20 — a menu a process can raise, and the mutating verbs · 3 d · DONE

**Closes.** R14, R16, R17, A9.

**ABI.** `SYS_win_menu: 60`, `win_menu(fd, x, y, byteregion)` with `x`/`y` in **surface px** —
the unit the `WEV_POINTER` that asked for the menu already carries (constraint 223), converted
page-side by `Surface.clientAt` (`src/wm/surface.mjs:177-186`), which is the declared inverse of the
`pointAt` that produced it. Not device px: that is `win_surface`'s unit and a surface is not
obliged to be the client box (PRD §2). Reuses `encodeWinItems`/`decodeWinItems` verbatim so the item
record keeps one definition. `WITEM_CONTEXT: 0x40` — the **seventh** item flag, six being declared
today — and `WITEM_FLAGS_ALL` `0x3f` → `0x7f`, which `src/abi.mjs:2211`'s self-test asserts is the
OR of the declared flags.

**The dismissal is a negative index, and it needs `itemAt(ev)` to arrive as one.** `WEV_ITEM` with
`a = -1` reads back as `4294967295`: `decodeWinEvent` takes `a` with `getUint32`
(`src/abi.mjs:1409`) and `WEV_ITEM` has no sign-restoring accessor the way a pointer's coordinates
do (`pointerAt`, `:1423-1425`). So this row adds `itemAt(ev)` beside `pointerAt`, returning
`{ index: ev.a | 0, where: ev.c >>> 0 }`, and a dismissal is `index < 0`. An accessor and not an
unsigned `0xffffffff` sentinel, because this ABI's standing answer to a signed field in an unsigned
record is **one** place that undoes it — constraint 225 is the record of what a caller reading one
raw costs — and a sentinel asks every reader to remember that `a` is unsigned here and signed one
record type over. The kernel writes the sentinel, so its index range check on a real activation is
unchanged.

**Programs.** `files` gains New folder, F2 rename in place, Delete, Cut/Copy/Paste and two context
menus. `src/bin/desktop.mjs`'s own menu moves onto `win_menu` rather than keeping the shell's
hard-coded path, which is what makes the new call load-bearing rather than decorative.

**Proof.** Every verb asserts the **filesystem**, not the drawing: a created directory appears in a
fresh `readdir`, a rename moves the inode, a paste produces equal bytes. A driven right-click raises
**this** system's menu — a `win_menu` reached the kernel and `defaultPrevented` is true on the browser
event. A row activates and the `WEV_ITEM` is read back. Esc dismisses and the dismissal is reported.
**Each refusal's errno is asserted separately**, because a single "it refused" passes for a filesystem
that refused for the wrong reason — M3's `truncate` answered ENOENT where it owed EROFS.

**Negative controls.** `no-menu-guard` removes the `contextmenu` listener: the `defaultPrevented`
clause MUST fail. `silent-dismiss` swallows the dismissal report: the Esc clause MUST fail alone.
`menu-in-surface` is a program flag making it draw its own menu into its surface: the clause
asserting the menu extends **past** `.window-body`'s rectangle MUST fail — `overflow: hidden`
(`src/wm/aero.mjs:409`) is why a process must not draw one.

**If the assumption is wrong.** The assumption is that `/usr/share` can stop being the default
directory. It is `EROFS` (`src/kernel/providerfs.mjs:180`) and `src/bin/files.mjs:41` opens it, so
every mutating verb is unreachable there. This plan's answer is `/desktop` (§7.3). What it does NOT
answer is what Delete does when the volume is mounted read-only, which is the PRD's §10.1 and a
human's — if that is unresolved when the row starts, Delete ships refusing by name and the refusal
is asserted, which is the safe default and reversible.

> **CORRECTION, from the implementation. The paragraph above is OBSOLETE and is kept rather than
> edited, which is this repo's rule for a falsified claim.** Two of its three sentences are now
> wrong and the third landed somewhere else.
>
> 1. **`/desktop` is not the answer; `/Users/Default` is.** §7.3's `/desktop` was never built.
>    `std.sessionDir(env)` is the one definition of where a program lands, and M19a's seed puts a
>    writable copy of the read-only base there (`src/kernel/seed.mjs`).
> 2. **THE READ-ONLY CASE WAS REMOVED, NOT HANDLED, SO THE FALLBACK THIS PARAGRAPH PROMISED MUST
>    NOT EXIST.** `docs/PRD-SHELL.md` §10.1 is **CLOSED**, answered by the repository owner in his
>    own words and recorded as `docs/DECISIONS.md` **D40**: *"i would like all operating systems to
>    be a copy of the read only base. then each session can be modified freely."* So "Delete ships
>    refusing by name" was not built, and building it would be a branch for a world the product no
>    longer has — a branch no check can reach. §M19a above says the same thing prospectively; this
>    is the row it was about.
> 3. **The refusals M20 DOES assert are the read-only MOUNTS, which §10.1 never was.** `/usr` is
>    still `MNT_RO` with `mutErrno: "EROFS"` and still refuses at two independent layers, so
>    `check_m20`'s `readOnly` proof navigates there deliberately and asserts **EROFS by name** —
>    and asserts the window still raised a menu, so the refusal is the verb's and not the menu's.
>    That is a refusal over a mount a reader can still walk into, not a refusal over the directory
>    a reader lands in. The two were conflated in the paragraph above.

---

### M21 — the Recycle Bin, refresh, and a drop target · 2.5 d

**Closes.** R15, R18, R19, A11.

**ABI.** `SYS_utimes: 61` and `SYS_realpath: 62`. Both are **implemented and unreachable**:
`src/fs/vfs.mjs:702-706` journals `OP.UTIMES` and `:923-925` replays it; `src/fs/vfs.mjs:509` is a
full symlink-resolving canonicalizer; `docs/ABI.md:134` lists both as if they existed. Plus the
reconciliation check between `docs/ABI.md` and `SYS_NAME` — the document claims 71 calls and `SYS_NAME`
is 60.

**Programs.** `files` becomes a drop **target** (it reads no `WEV_DROP` today — `:438-486`) and gains
F5 and a Bin location. `src/bin/touch.mjs` loses the admission at `:3-8` that it cannot set a
timestamp. `src/bin/desktop.mjs:187`'s "THERE IS NO RECYCLE BIN" comment goes with the thing it
records.

**Proof.** A delete leaves the bytes reachable from the Bin and a restore returns them. A restore onto
an occupied path **refuses by name**. A cross-window drag with Ctrl held reports `DOBJ_EFFECT_COPY`
with the source still present. F5 re-lists and the selection survives for the rows that survive.

**Negative controls.** `restore-overwrites` lets a restore clobber an occupied path: the refusal clause
MUST fail. `move-forced-copy` ignores the modifier: the effect clause MUST fail alone.
`stale-listing` serves the cached rows: the F5 content clause MUST fail alone.

**If the assumption is wrong.** The assumption is that a reserved directory plus a sidecar is enough
— no new filesystem concept. If a sidecar cannot survive a torn journal, `scripts/fsfuzz.py` says so
in three seconds, and the Bin becomes a real inode flag, which is a week and a constraint rather than
two days.

---

### M22 — the shell's remainder · 3 d

**Closes.** R21, R22, R23, R24, R25, A14.

**Depends on M18 and M20**, and on neither M19 nor M21 — see §3.

**ABI.** An **eighth** `WITEM_*` bit for a tray icon, `0x80`, with `WITEM_FLAGS_ALL` going `0x7f` →
`0xff`. M20 took the seventh (`WITEM_CONTEXT: 0x40`), so this row is the second move of that mask and
not the first. `A14`'s substitute-chord table, one definition, read by the menus and the dispatcher.

**Programs.** `src/bin/desktop.mjs` publishes pinned rows and a tray row. `src/bin/editor.mjs` gets
the shared Save As dialog — which needs M20's `win_menu` for the dialog's own menus — and that retires
the defect at `:247`: its "save and close" writes `[saved]` to the **window** fd and not to the file,
so a reader is told their edit was saved and it was not.

**Proof.** The taskbar band reaches every button past the 42 CSS px shrink floor
(`src/wm/aero.mjs:577-583`, whose comment says it scrolls while its CSS clips it). A pinned button
survives a reload and launches. A tray icon is withdrawn when its process dies — asserted by killing
the process, not by asking it to withdraw. `editor`'s save writes **bytes to the file**, read back
through a fresh `open`.

**Negative controls.** `tray-outlives` skips the teardown withdrawal: the tray clause MUST fail alone,
which is the classic tray defect. `band-clips` restores `overflow: hidden`: the reachability clause
MUST fail. `save-to-window-fd` restores the current `editor` behaviour: the bytes clause MUST fail and
every drawing clause MUST hold — which is exactly how the defect shipped.

**If the assumption is wrong.** The assumption is that a chord substitutes acceptably for Alt+Tab.
`bench/m22-switch/probe.py` reports which candidates are free in each engine; the choice among the
free ones is the PRD's §10.3 and a human's, not this plan's. If every candidate is taken by the host
in one of the two engines, R22 ships as a published chord that works in one engine and is
**labelled** as such in the menu — a menu showing an accelerator the system cannot receive is the
live-looking-button defect, so the label is the requirement, not a nicety.

---

### M23 — thumbnails, views, the breadcrumb, panes, columns, search · 4 d

**Closes.** R26–R31, A7, A10. A13 is not landed — see §6.

**ABI.** `DL_BLIT: 8`, taking a **data-object fd** holding a `DOBJ_BITMAP` payload — the header has one
definition already (`BMP_*` + `encodeBitmap`/`decodeBitmap`, `src/abi.mjs:793`, `:1735`) and a data
object's bytes are kernel-owned and refcounted, so the lifetime problem is solved rather than new.
Destination coordinates are **surface px**, like every other display-list coordinate — not device
px, which is `win_surface`'s unit (PRD §2). Pixels MUST NOT travel inline: 24 payload bytes is six pixels,
worse than one `DL_FILL_RECT` each. A10's dirent-plus-stat is a **cost** fix, not a capability fix —
M19 already pays an `lstat` per row.

**Programs.** `files`, `imgview`.

**Proof.** A `DL_BLIT` of a known bitmap, read back with `surface.pixel` in the shape `pixelColor`
renders an asked-for colour into (constraint 224), plus the refusal path: a short payload and a wrong
fd kind each assert **their own** errno, validated whole before anything is drawn — the rule
`src/kernel/calls.mjs:1103-1115` already applies to a malformed text run.

**Negative control.** `blit-unvalidated` accepts a short payload: the errno clauses MUST fail and the
drawn-pixel clause MUST hold, so the control is scoped to validation alone.

**If the assumption is wrong.** The assumption is that a decode happens where a decoder exists.
Nothing in this system decodes a PNG — `src/bin/imgview.mjs:76-82` reads the signature and the IHDR
and says "THIS IS NOT A DECODER" — and a locked-down realm has no `createImageBitmap`
(`src/libos/lockdown.mjs`). If no honest decode site is agreed, R26 ships for `.rgba` payloads only
and a PNG falls back to its type icon, which is the stated fallback and not a silent one.

---

## 3. The dependency graph

```
M15a  (the registry gate)
  │   blocks nothing technically; blocks REPORTING anything below as done
  ▼
M16-probe  (0.5 d: can CDP drive a grip? does mouseWheel reach a canvas?
  │         can the suite be driven at a chosen dpr?)
  ▼
M16  client box = surface, in device px
  │   R1 R2 R8 R10 R34 A2
  ├────────────┬────────────┐
  ▼            ▼            │
M17 wheel   M18 keys        │
  R3 R20      R4 R5 R6      │
  A1 A6       R9 A3 A4      │
  │            │            │
  └──────┬─────┘            │
         ▼                  │
      M19 columns + hover ◄─┘   M19 needs M17's DL_CLIP for a clipped
         R7 R11 R12 R13         column and M18's keys for Shift+click
         R20 A5 A8 A12
         │
         ▼
      M19a session = writable copy    inserted: M20's verbs need a
         the PRD's §10.1, D40         writable directory to run in
         │
         ▼
      M20 menus + verbs
         R14 R16 R17 A9
         ├──────────────────┐
         ▼                  ▼
      M21 bin+refresh    M22 shell remainder
         R15 R18 R19        R21 R22 R23 R24 R25 A14
         A11                │
         └────────┬─────────┘
                  ▼
                M23 views + thumbs + search
                  R26-R31 A7 A10
```

Read as obligations:

- **M16 unblocks every later row's proof.** A check that resizes and reads content back, in a named
  unit, is the instrument the rest are measured with.
- **M17 unblocks M19 and M23.** `DL_CLIP` is what stops a scrolled row painting over a header and a
  long name overrunning its column; without it R7 and R27 draw outside their boxes. M17 also lands
  the forged-event guard that M16's event needs.
- **M18 unblocks M19, M20 and M22.** Shift+click needs an anchor and a click count; F2, Delete and F5
  need A3; R24's pinned launch and R25's dialogs need the association table.
- **M19a unblocks M20, and it is the reason the row was inserted.** A mutating verb needs a directory
  it can mutate, and the file manager's default was a read-only mount. It also deletes work rather
  than adding it: with nothing a reader reaches read-only, M20's verbs need no read-only branch.
- **M20 unblocks M21 and M22.** A Bin with no menu and no confirm is a verb with no gesture; and
  R25's shared Save As dialog needs A9's `win_menu`, and R23's tray bit is the second move of a mask
  M20 moves first.
- **M21 and M22 are independent of each other** and may run in parallel if two hands are available.
  Nothing in M22 reads `utimes`, the Bin or the drop target.
- **M23 depends on M19 and M21** and on §6's deferral. It is the only row that may be cut whole
  without breaking a row above it.

---

## 4. M16 in implementable detail

Enough to start from this section alone. Three facts carry it, and two are already in the code.

**Fact one: the client box is MEASURED, page-side, and MUST NOT be derived from `WIN_CAP_H` and
`WIN_INSET`.** The derivation is wrong twice over, and the PRD §2 carries both reasons: the
`border-top: 1px solid` on `.aero-desktop .window-body` (`src/wm/aero.mjs:406`) against a box that is
not `box-sizing: border-box`, so the content box the canvas fills is 1 px shorter than the model; and
the four proof pages, which do not import `aero.mjs` at all (`grep -n aero www/m7.html` is empty), so
on four of five hosts those constants describe no element. Constraint 264 and CLAUDE.md's finding are
the rule: a geometry derived from a measured rect survives a second engine, one derived from a
constant does not.

The page already measures the right element. `#report` reads
`entry.win.bodyEl.getBoundingClientRect()` (`src/wm/winhost.mjs:671`) for the terminal's cell count.
The canvas's extent is the **content** box, `bodyEl.clientWidth`/`clientHeight`, which excludes that
border.

**And the partition identity is worth asserting, but `winClientBox` is NOT worth exporting.**
`blurRingArea(w,h) + max(0, w - 2·INSET)·max(0, h - CAP_H - INSET) === blurBoxArea(w,h)` holds for
every `h` **when `w >= 2·WIN_INSET`** — the ring and the modelled complement partition the border
box — and **fails for every `0 <= w < 2·WIN_INSET` with `h > WIN_CAP_H`**, because
`blurRingArea`'s `sides` term does not depend on width (`src/abi.mjs:1765`) while the complement
clamps to zero. The PRD's §2 carries the measured table and the reproduction; the short form is
`w = 0, h = 100` → `852` against a box of `0`.

**So the self-test asserts the narrow claim, over `w >= 2·WIN_INSET` only.** A clause including
`w = 0` fails the build. The narrow claim is the one the governor needs: `clampBox` floors a width
at `MIN_W` (`src/wm/window.mjs:109`, `MIN_W: 220` at `:40`), so no window the clamp can produce is
within 18× of the bound, and a sweep of `w ∈ [2·WIN_INSET, 2000]` against `h ∈ [0, 2000]` reports no
failure.

**`winClientBox(w, h)` is not added.** Its only caller would be that self-test, and a function that
exists to be tested is dead weight — the identity's complement is a term in one assertion, written
there, in the same file as `blurRingArea` and therefore not a second copy across any boundary.
Nothing else in the system wants the modelled complement: `governBlur` accounts the ring
(`src/kernel/wins.mjs:1091`), and the canvas's box is measured, which is Fact one above. The
assertion says nothing about any element on the page, so it does not substitute for the measurement.

**Fact two: the kernel's resize path and the page's canvas rebuild already work** (§1, items 1 and 2).

**Fact three: `MIN_H` is 120 CSS px and `CAP_H + INSET` is 35** (`src/wm/window.mjs:41`), so the
modelled client box is never degenerate and no guard is needed for a negative height. Stated because
a reader will look for one. The **measured** box still needs a positive-value guard, because a frame
in a `display: none` subtree measures zero.

### 4.1 `src/abi.mjs`

```js
  //: M16. THE CLIENT CONTENT BOX CHANGED, in DEVICE pixels — the unit `win_surface` takes and the
  //: unit `SURFACE_MAX_PX` is sized in. `a` = width, `b` = height, `c` = the device-pixel ratio in
  //: 16.16 fixed point. THE RATIO RIDES THE RECORD because a process has no other route to it:
  //: the only dpr channel runs page -> kernel (src/wm/winhost.mjs:95 -> kernel.mjs:2033) and the
  //: kernel kept only the square. A program's layout constants are CSS px; this is what converts
  //: them.
  //:
  //: THE BOX IS THE PAGE'S MEASUREMENT of `bodyEl.clientWidth`/`clientHeight`, not a derivation
  //: from WIN_CAP_H and WIN_INSET: `.window-body` carries a 1 px border-top and is not
  //: border-box, so the model is a pixel taller than the box the canvas fills, and four proof
  //: pages do not load that stylesheet at all.
  //:
  //: IT IS NOT `WEV_RESIZE`, and the two must not be merged. `WEV_RESIZE` carries CELLS
  //: (src/kernel/wins.mjs:387) and `src/bin/term.mjs:277` feeds them to `winsizeSet` — a
  //: reinterpretation would resize a terminal's grid to 640x440 columns. It also fires for changes
  //: `WEV_RESIZE` suppresses: a resize that changed no cell count changed every pixel of a surface.
  WEV_CLIENT: 13,
  WEV_MAX: 13,
```

`clientBoxAt(ev)` beside `pointerAt` (`src/abi.mjs:1424`) — **named `clientBoxAt` and not
`clientAt`**, because `Surface.clientAt` already exists as the declared inverse of `pointAt`
(`src/wm/surface.mjs:164-186`) and both get imported into the same pages:

```js
export function clientBoxAt(ev) {
  return { w: ev.a >>> 0, h: ev.b >>> 0, dpr: (ev.c >>> 0) / 65536 };
}
```

Self-test clauses: `WEV_MAX === 13`; an `encodeWinEvent`/`decodeWinEvent` round trip whose
`clientBoxAt` returns a dpr of exactly `2` and exactly `1.5`; and the partition identity, over sizes
**whose width is at least `2 * WIN_INSET`**:

```js
  //: THE RING AND THE MODELLED COMPLEMENT PARTITION THE BORDER BOX, which checks `blurRingArea`
  //: from both ends: an error in the cap, the sides or the bottom term breaks the sum.
  //:
  //: WIDTH >= 2*WIN_INSET IS A PRECONDITION AND NOT A CHOICE OF INPUTS. The `sides` term above
  //: does not depend on width, so for w < 2*WIN_INSET the ring is non-zero where the complement
  //: has already clamped to zero and the sum exceeds the box — w=0,h=100 gives 852 against 0.
  //: That is not a defect in the governor: `clampBox` floors a width at MIN_W = 220
  //: (src/wm/window.mjs:40, :109), so no window reaches the degenerate band. Widening this clause
  //: to w = 0 asserts something false and fails the build.
  for (const [w, h] of [[12, 0], [12, WIN_CAP_H], [12, 35], [12, 120], [220, 120],
    [440, 138], [640, 440], [900, 138], [1280, 800], [2560, 1440], [13, 31], [220, 29]]) {
    const complement = Math.max(0, w - 2 * WIN_INSET) * Math.max(0, h - WIN_CAP_H - WIN_INSET);
    if (blurRingArea(w, h) + complement !== blurBoxArea(w, h)) {
      fail(`the ring and its complement do not partition ${w}x${h}`);
    }
  }
```

### 4.2 `src/kernel/wins.mjs`

**The dpr becomes one fact.** `this.dprSq = 4` (`:545`) is the only ratio the kernel holds, and a
client event needs the ratio itself. One `setDpr(dpr)` that sets both, with `dprSq` a getter — never
two independently assigned fields. `src/kernel/kernel.mjs:2033`'s
`if (m.dpr > 0) WINDOWS.dprSq = m.dpr * m.dpr;` becomes `WINDOWS.setDpr(m.dpr)`, keeping the
`> 0` guard: a 0 would make every blur cost 0 and silently disarm the governor, which is what the
comment above it already says.

**`setBox` raises the event**, from the measured client box the page now sends in `win-geom`. After
`this.box = {...}` (`:379`), before the `WEV_RESIZE` push at `:387`:

```js
    const cw = box.clientW | 0;   // DEVICE px, measured page-side
    const ch = box.clientH | 0;
    if (cw > 0 && ch > 0 && (cw !== this.clientW || ch !== this.clientH)) {
      this.clientW = cw; this.clientH = ch;
      this.pushClient(cw, ch);
    }
```

The `> 0` guard is the one Fact three says is needed: a frame measured in a hidden subtree reports
zero, and a zero-sized `win_surface` is `-EINVAL` (`src/kernel/wins.mjs:1031-1034`), so a program
told zero would see a refusal it cannot act on.

`pushClient` **REPLACES a tail `WEV_CLIENT` rather than appending.** A2b reports per animation frame,
so an appending client event is ~240 records in a two-second drag against `WIN_EVENT_CAP` 256, and
`push` drops the newest (`:298-301`) — the record discarded would be the final size. A stale size has
no history worth keeping, which is the same argument constraint 243 makes against `DRAG_OVER` and the
one A5 makes for hover. **The replacement MUST increment a `coalesced` counter, published in `/proc`
beside `dropped:`.** `dropped` cannot see this: it moves only on a full ring, and a drained ring
never fills, so without `coalesced` a control that broke the replacement would move no expectation.

`clientW`/`clientH` initialise to `-1`, so the first `setBox` **that measures a positive box** raises
one — not simply the first, because the `> 0` guard above drops a measurement taken in a hidden
subtree and leaves `clientW` at `-1` for the next one to raise. That is deliberate: a
program needs the box before its first paint, and A2c's `/proc` line is the pull route, not a
substitute.

### 4.3 `src/kernel/procfs.mjs` — A2c

Four lines in `winLines` (`:69-104`), beside `box:` and `cells:` and in the block that already holds
`dropped:` at `:90`.

**`winLines` cannot reach the manager and the dpr is not a per-window fact, so the signature gains
an argument.** `winLines(win, slot)` (`:69`) closes over nothing: `procfs.mjs` has **no `K`
binding** — `grep -n '\bK\b' src/kernel/procfs.mjs` is empty — and the manager is reached as
`ctx.wins()` inside `makeProcFS`'s helpers (`:146`, `:153`), which is a getter function and not a
property. A `${K.wins.dpr}` in `winLines` is a `ReferenceError` at the first read of
`/proc/<pid>/win/<winid>`, which is a kernel fault on a `/proc` path, not a missing line. So:

```js
// `mgr` is the WinMgr, for the DPR ALONE — it is a display fact and not a window's, so it cannot
// come off `win`. The caller has already resolved `win` through `winOf`, which returns null when
// `ctx.wins()` does, so `mgr` is non-null wherever this runs.
function winLines(win, slot, mgr) {
  ...
    `surface:\t${win.surface ? `${win.surface.w}x${win.surface.h}` : "-"}`,
    `client:\t${win.clientW}x${win.clientH}`,
    `dpr:\t${mgr.dpr}`,
    `coalesced:\t${win.stats.coalesced}`,
```

and the one call site (`:245`) becomes `content: winLines(win, slot, ctx.wins())`.

`surface:` and `client:` are device px and MUST be labelled so in the docstring; `box:` above them is
CSS px, and two unlabelled integers in two units in one file is the defect this milestone is about.
The kernel already holds `win.surface = { w, h }` (`src/kernel/wins.mjs:1049`) and printed none of it.
`mgr.dpr` is the field §4.2's `setDpr` introduces; there is no `dpr` on `WinMgr` today, only
`dprSq` (`src/kernel/wins.mjs:545`), which is why that edit lands before this one.

### 4.4 `src/wm/surface.mjs` — the sizing moves HERE, not into the skin

The canvas's CSS box belongs with the renderer that owns the canvas, not with a skin.
`www/m7.html`, `m8.html`, `m9.html` and `m10.html` do not import `aero.mjs` at all —
`grep -n aero www/m7.html` is empty — so their `.surface { width:100%; height:100% }` rules are not
duplicates of an aero rule but four independent statements of the same fact, and an aero rule would
make five.

A surface's **extent** is its contract with the kernel: the accounted area must be the visible area,
or constraint 49's governor accounts a rectangle nobody renders. That is not a skin choice. So it is
set inline in the constructor beside `canvas.width = this.w` (`:48`):

```js
    // THE CANVAS FILLS ITS CLIENT AREA, AND THIS IS NOT A SKIN CHOICE. The kernel accounts the
    // area it granted (D31) and the governor accounts the ring around it (constraint 49), so a
    // canvas whose CSS box is not its client area makes both accounts describe a rectangle nobody
    // renders. Set INLINE rather than in a stylesheet because five hosts render a surface —
    // src/wm/aero.mjs and four unskinned proof pages — and a fact with five renderers has none.
    // `.window-body` is `display: flex`, so the flex terms are part of "fills".
    if (SURFACE_FILL) {
      Object.assign(canvas.style, {
        display: "block", flex: "1 1 auto", minWidth: "0", minHeight: "0",
        width: "100%", height: "100%",
      });
    }
```

**This does not forbid scaling, and must not.** `:33-35` documents the contract that a backing store
smaller than the box is stretched to it, and `www/m8.html`'s 4×4 pattern proof reads its pixels back
through exactly that stretch (`www/m8.html:25-30`). What changes is that a program now learns the
box, so the stretch is what a reader sees **during** a drag and not after it. The four pages'
`width`/`height` declarations become dead and go; their `background` and `image-rendering` stay,
because those genuinely are per-page looks.

`setSurfaceControls({ noFill })` sets `SURFACE_FILL`, matching `setHostControls`
(`src/wm/winhost.mjs:76-82`) and `setGeometryControls` exactly — a module-level control object read
from a query parameter by the page, which is what makes `--negative no-surface-fill` re-runnable
rather than a source edit.

Record the placement as **proposed D40**, since it departs from `src/wm/window.mjs`'s standing rule
that the frame "names nothing about how it looks". Extent is not look; the departure is recorded where
a reader meets it.

### 4.5 `src/wm/winhost.mjs`

**A2d — the re-surface must not steal focus.** `#surface` ends with `entry.surface.el.focus()`
(`:525`), on every `win-surface` including the resize branch that just destroyed the previous canvas.
Capture the state before the destroy at `:503`:

```js
    const resurface = !!entry.surface;
    ...
    this.stats.resurfaces += resurface ? 1 : 0;
    if (!resurface) entry.surface.el.focus();
```

`#wirePointer(entry)` at `:524` stays as it is — it attaches to the **new** element, so there is no
leak and no double delivery. Stated because a reader will check.

**R8 — the browser's menu.** One listener in `#wirePointer` (`:545`), beside the `pointerdown`
listener at `:562` and matching the three existing `preventDefault` sites
(`src/wm/window.mjs:280`, `src/wm/desktop.mjs:174`, `src/wm/taskbar.mjs:347`):

```js
    /* M16. A FOREIGN MENU DRAWN OVER THE OPERATING SYSTEM is the clearest breach available, and
     * `#wirePointer` wired pointerdown/move/up/cancel/keydown/focus/blur and not this one. The
     * menu a process raises is M20; this only stops the host's. */
    el.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      this.stats.contextmenus += 1;
    });
```

**`#report` sends the measured client box, and it has SEVEN call sites.** `#report(entry)` is defined
at `:667` and called from `:277`, `:433`, `:446`, `:447`, `:653`, `:778` and `:813` — so adding two
fields to its `win-geom` post covers every route a geometry already travels, which is the reason to
put them there rather than in a new message:

```js
    const dpr = window.devicePixelRatio || 1;
    ...
      clientW: Math.round(entry.win.bodyEl.clientWidth * dpr),   // DEVICE px, content box
      clientH: Math.round(entry.win.bodyEl.clientHeight * dpr),
      dpr,
```

`clientWidth`/`clientHeight` and not `getBoundingClientRect()`: the rect is the **border** box and
`.window-body` carries a 1 px `border-top` (`src/wm/aero.mjs:406`), so the rect is a pixel taller
than the box the canvas fills. The existing `cols`/`rows` keep reading the rect, unchanged — a cell
count off by a pixel of border is not a defect and changing it would move M4's expectations for no
reason.

**A2b — report mid-drag, coalesced per frame.** None of the seven call sites is inside the gesture;
the one the resize relies on is the frame's `pointerup` at `:446`. Add `#reportSoon(entry)` guarded
by one `requestAnimationFrame` per entry, and pass `onGeom` into `Win` at creation, matching
`onClose` (`src/wm/window.mjs:128`), `onState` (`:157`) and `onMenu` (`:159`):

```js
      onGeom: () => this.#reportSoon(entry),
```

A per-sample post would be one `win-geom` per pointermove, which is the thing A1's own argument
forbids. One per frame is the honest ceiling, and the kernel's tail replacement (§4.2) absorbs it.

### 4.6 `src/wm/window.mjs`

`this.onGeom = spec.onGeom || null;` in the constructor, and the resize `move` handler's last two
lines (`:754-755`) become:

```js
      this.box = next;
      this.apply();
      /* THE KERNEL LEARNS MID-DRAG, and the release-only report was a defect with two faces.
       * `/proc` and `governBlur`'s `blurRingArea(win.box.w, win.box.h)` described the PRE-DRAG
       * rectangle for the whole gesture — constraint 49's under-read in the direction constraint 49
       * forbids. And when `setPointerCapture` throws (Firefox does, constraint 175) the gesture
       * continues on document listeners and a release outside the frame never reaches the
       * `pointerup` hook, so the kernel kept the pre-drag box PERMANENTLY. */
      if (this.onGeom) this.onGeom("resize");
```

The drag `move` handler gets the same call, for the same reason.

### 4.7 `src/libos/std.mjs` — one branch, five callers

```js
/**
 * A surfaced program's answer to WEV_CLIENT: re-ask for a surface at the new size and report what
 * changed. FIVE PROGRAMS NEED EXACTLY THIS — files, editor, imgview, paint, taskmgr — so a second
 * copy is how two of them come to disagree about whether a repaint is owed. Three of them share
 * one discard branch (`grep -n "WEV_RESIZE || ev.type === WEV_FOCUS" src/bin/*.mjs`); `paint`
 * (src/bin/paint.mjs:215) and `taskmgr` (:349) each have their own, which is why the grep names
 * four of the five and `desktop`.
 *
 * THE EVENT'S w/h ARE ALREADY DEVICE PIXELS, which is the unit `win_surface` takes, so they are
 * passed through unscaled. The dpr is returned BESIDE them because the caller's own layout
 * constants are CSS px and this is their only route to the factor.
 *
 * ONE RE-SURFACE PER DRAINED BATCH, not per event. The kernel coalesces into one record per batch
 * and `win_surface` destroys and rebuilds a canvas page-side (src/wm/winhost.mjs:503-521), so a
 * per-sample re-surface is a canvas rebuild per animation frame. Between two of them the canvas is
 * CSS-stretched, which is what Windows 7 shows while a window is being dragged bigger — the stretch
 * is correct DURING a resize and wrong after it.
 */
export function resurface(env, fd, ev) {
  const want = clientBoxAt(ev);
  if (!(want.w > 0) || !(want.h > 0)) return { ok: false, errno: EINVAL, w: 0, h: 0, dpr: 1 };
  const rc = env.win.surface(fd, want.w, want.h);
  if (rc < 0) return { ok: false, errno: -rc, ...want };
  return { ok: true, errno: 0, ...want };
}
```

A refusal MUST be surfaced by the caller and not swallowed: `-ENOMEM` from the budget is a ceiling, not
a transient (`src/kernel/wins.mjs:1041-1046`), so a program that retried would retry for ever.

### 4.8 `src/bin/files.mjs` — and the unit conversion, in ONE place

`SURFACE_W` (`:56`) and `MAX_ROWS` (`:69`) stop being constants and become state. The program's
layout constants stay **CSS px** — `ROW_H`, `ROW_GAP`, `PAD`, `HEAD_H`, `GLYPH_W`, `TEXT_PX`,
`NAME_X`, `TYPE_RIGHT` are a list view's metrics and a reader reasons about them in CSS px — and the
conversion happens **once**, at the boundary:

```js
      const got = env.std.resurface(env, made.fd, ev);
      if (!got.ok) { account.why = `win_surface: ${env.std.errnoName(got.errno)}`; break; }
      if (!CONTROL_FROZEN_SURFACE) { relayout(got.w / got.dpr, got.h / got.dpr, got.dpr); }
```

`relayout(wCss, hCss, dpr)` recomputes `SURFACE_W = wCss`, `NAME_X`, `TYPE_RIGHT`, the live `S = dpr`,
and `MAX_ROWS = Math.max(1, Math.floor((hCss - HEAD_H - PAD * 2 + ROW_GAP) / (ROW_H + ROW_GAP)))` —
the inverse of the height arithmetic at `:229-230`, written once in one direction and read in both,
which is what `rowAt`/`rowY` already do for a row's y.

**Every drawing coordinate is multiplied by `S` on the way into the display list, and nowhere else.**
A per-constant scaling is how two of them come to disagree. A text op's `size` is multiplied too —
`a2` is surface px (`src/wm/surface.mjs:119`).

**And `rowAt` MUST divide by `S`.** `pointerAt` returns **surface** pixels (constraint 223), and
`S` is what converts between the program's CSS-px layout and its surface. Surface px are not device
px in general — a surface may be smaller than its client box, deliberately
(`src/wm/surface.mjs:33-35`) — but for `files` after this row they coincide, because `resurface`
asks for exactly the client content box the event reported in device px. That coincidence is what
makes one factor `S` enough, and it is the thing `--css-px-surface` breaks.

Today the program's constants and the surface happen to share a numeric scale, because `SURFACE_W`
was passed to `win_surface` unconverted — so hit-testing is internally consistent and only the
display is wrong. The moment the surface becomes the real client box in device px, an undivided
`rowAt(at.y)` lands two rows off at dpr 2. This is the same unit error on the input side and it is
invisible until the output side is fixed.

`FILES_METRICS` (the export at `:71`, read by `www/m10.html` and `bench/m10-data/shell.py`) gains the
live width **and the dpr**, so the two outside readers follow a resize instead of drifting; that is
the single-source row CLAUDE.md already names, with its consequence spelled out — a drift there
arrives as the WRONG FILE being dragged.

`src/bin/files.mjs:20-24`'s header comment — "THE ROWS HAVE NO LABELS AND THAT IS NOT AN OVERSIGHT …
there is no text op" — is false since M15 and goes with this row: a stale comment in the file R7, R20
and A8 all edit is a reader's first wrong turn.

The branch at `:439` splits:

```js
      if (ev.type === WEV_FOCUS) continue;
      if (ev.type === WEV_RESIZE) continue;   // CELLS. A canvas program renders no cell grid.
      if (ev.type === WEV_CLIENT) { /* as above */ repaint = true; continue; }
```

`CONTROL_FROZEN_SURFACE` comes from an argv flag `--no-resurface`, declared in the program's own
header as a negative control and nothing else. A second flag, `--css-px-surface`, passes the CSS-px
constants to `win_surface` unscaled — today's behaviour — which is the control that proves the suite
can see a unit error at all. The precedent is `cfg.blurBudgetPx` (`src/kernel/wins.mjs:1077`, "the
same bench-boot-only hook M3 uses") and `scripts/serve.py --no-isolation`: a shipped flag whose only
job is to break something, so the control is re-runnable and scored rather than a source mutation
nobody re-runs.

### 4.9 `src/bin/taskmgr.mjs` — R10 is the REGISTRATION, not the fix

**The code fix has landed.** `de8a68a` replaced `if (!(ev.b & WPTR_DOWN)) continue;` with
`if (!(ev.mods & WPTR_DOWN)) continue;` (`src/bin/taskmgr.mjs:341`) and kept the reason as a comment
at `:334-340`. `ev.b` is **y** (`src/abi.mjs:402`, `pointerAt` at `:1424`) and `WPTR_DOWN` is `0x10`
(`:464`); rows are 18 px from y = 40 (`src/bin/taskmgr.mjs:54`), so the old test selected a row only
where `y & 0x10` was set — and `t` and `x` kill whatever that landed on (`:270-281`).

**What this row owes is the registered check.** `grep -n taskmgr scripts/check.py` is empty: the
gate is `bench/m14-shell/taskmgr.py`, which the suite does not run, so the fix rests on a bench and
the next regression ships green exactly the way the original did. The clause drives five heights —
the failure was periodic in y, so one row passes by luck — and reads the selection out of the
**pixels the program drew**, because `taskmgr` has no state channel to ask. The `ev-b-pointer`
control restores the old test.

This row also takes `taskmgr`'s own `WEV_RESIZE` branch (`:349`), which repaints at the size it
already had rather than discarding — so it is an edit and not a new branch.

### 4.10 `www/m16.html`, `scripts/check.py`, `scripts/check_floors.json`

`www/m16.html` follows `www/m14.html`: the **product** at the bare URL, `?proofs=1` for the harness
(constraint 283), a gesture banner when nothing is driving it, and `node --check` clean under
`scripts/check_pages.py` — a `const` shadowing a binding fifty lines up cost `--only m14` **420
seconds** to report as BROKEN, and the page gate names the line in about a second.

It reads `no_surface_fill`, `frozen_surface`, `css_px_surface`, `report_on_release` and `ev_b_pointer`
from `location.search` and passes them to `setSurfaceControls`, the program's argv, the program's
argv, `setHostControls` and the program's argv respectively, exactly as `www/m13.html:84-98` does.

`check_m16` registers through the one decorator with `M16_LABELS` as its inventory — `min_expectations`
is `len(labels)` and never written twice — five `NegativeControl` entries with their own `_FAILS`
tuples and `held_rest(M16_LABELS, ...)`, and a floor in `scripts/check_floors.json`.

`_perform_gesture` gains nothing for the grip: a grip drag is a `drag` gesture whose `from` is the
grip's measured rect, and `mouse_drag` already exists. **The page measures the grip and the check
performs** — that is M13's protocol, unchanged. What it does gain is a `wheel` kind for M17, and the
run gains a dpr axis: the geometry clauses are asserted under `--force-device-scale-factor=1` and
`=2`, because a figure measured at one ratio is what cost M12 a milestone (constraint 264).

---

## 5. What could go wrong, and the cheapest measurement

| Milestone | The risk | Cheapest measurement, and when |
| --- | --- | --- |
| M15a | M15's coreutils need a real pty the registered harness cannot reach, so the registration cannot assert the thing it is about | Run `bench/m14-shell/coreutils.py` under the registered `Env` once, before writing labels. One hour. |
| M16 | `Input.dispatchMouseEvent` does not drive a grip, because the gesture takes a pointer capture and then listens on `document` (`src/wm/window.mjs:762-772`) | `bench/m16-resize/probe.py`: build one frame, drag the SE grip with CDP, print the rect before and after. **Half a day, before any code.** |
| M16 | The suite cannot be driven at a chosen dpr, so the unit defect stays invisible to it — which is how it shipped | The same probe, same half day: launch with `--force-device-scale-factor=2`, read `devicePixelRatio` and one canvas's backing store against its rect. It also re-derives the PRD §1 table at both ratios, which that table is owed: the page that produced it is not committed. |
| M16 | The CSS fill changes the glass accounting, so M11 and M12 go red for a reason unrelated to this row | `scripts/check.py --only m11 --only m12` after §4.4. `blurCost` has no surface branch (`src/kernel/wins.mjs:1086-1092`) and the client area was already opaque and outside the ring, so the prediction is "no movement" — and a prediction that is checked is worth more than one that is argued. |
| M16 | Repeated re-surfacing exhausts `SURFACE_BUDGET_PX` | Read `/proc`'s new `surface:` line after 50 driven resizes. The release-before-charge at `:1040`/`:1047` predicts a flat figure. Twenty minutes. |
| M16 | A maximized window at dpr 2 asks for a surface past `SURFACE_MAX_PX` and `files` dies on a refusal it never expected | `node -e` over `src/abi.mjs`: `SURFACE_MAX_PX` against the largest client box at dpr 2 on the reference display. Minutes, and it decides whether `resurface`'s `-ENOMEM` path needs a degraded layout or only a message. |
| M17 | CDP `mouseWheel` does not reach a `wheel` listener on a canvas, so R3 is unmeasurable in the registered suite | The same `bench/m16-resize/probe.py` run, same half day: attach a `wheel` listener, dispatch, count. Answering it before M16's code is why the probe is one probe and not three. |
| M17 | `DL_CLIP` left set by batch N makes batch N+1 draw nothing — a window that goes blank on its next repaint with no error anywhere | `node bench/m17-wheel/probe.mjs`: two batches, the second with no clip op, assert the second drew. Under node, seconds. The fix is that `replay` resets the clip at the top of every batch; the probe is what proves the reset exists. |
| M18 | `a == 0` collides with a reader that treats an empty byte array as printable | `grep -rn keyBytesOf src/bin/` and read each caller's length guard. Ten minutes, before the ABI change. |
| M19 | The published advance table does not match the renderer's real font closely enough to lay out a column | One page that draws all 95 printable ASCII code points at each **declared** size and asserts `measureText` against the table within 0.5 px, in **both** engines and at **both** ratios. Half a day. CLAUDE.md's own finding is the reason: a geometry derived from a measured rect survives a second engine and one derived from a constant does not — M11 and M12 each cost a milestone to that. |
| M19 | Removing `if (!e.buttons) return;` (`src/wm/winhost.mjs:575`) floods a queue that `push` drops the newest from | Drive 500 buttonless moves and read `/proc`'s `queued:` and `coalesced:` — **not `dropped:`**, which a drained ring never moves. The tail-replacement prediction is `queued:` near the batch count and `coalesced:` near 500. Twenty minutes, and it is also the `no-hover-coalesce` control and the evidence constraint 223's amendment rests on. |
| M20 | No writable default location is agreed, so every mutating verb is unreachable from the desktop icon | `node -e` over `src/kernel/providerfs.mjs` printing the mount's write mode; then §7.3's decision. The measurement is minutes. What Delete does on a read-only mount is not measurable and is the PRD's §10.1. **CLOSED BY M19a**: the location is `/Users/Default`, a writable copy of the base, and §10.1 is answered by removing the read-only case rather than handling it (D40, constraint 306). |
| M21 | A Bin sidecar does not survive a torn journal | `scripts/fsfuzz.py` — 10,000 torn journals in about three seconds, in plain node, because nothing in `src/fs/` touches OPFS. This is the cheapest measurement in the whole plan and it is why `src/fs/` purity is a standing constraint. |
| M22 | Every Alt+Tab substitute is taken by the host in one of the two engines | `bench/m22-switch/probe.py`: log `keydown` for each candidate chord in Chrome and in Firefox over `scripts/bidi.py`. Two hours. It **prices** the PRD's §10.3; the choice among the free ones stays a human's. |
| M23 | There is no honest site for a PNG decode: a locked-down realm has none and the kernel is not an image library | Read `src/libos/lockdown.mjs`'s `TARGETS` — the single definition of what a realm loses — and check for `createImageBitmap`. Minutes. If it is stripped, R26 ships for `.rgba` with a named fallback. |

Two cross-cutting risks, and both have cost this project a milestone before.

- **A green Chrome suite over a product that does not work in Firefox.** It has happened four times
  (M4a's undraggable window, M6's realm where no process started, M11's constant-offset blur band,
  M12's dpr-2 budget figure) and all four were found by a human opening the page. Every row above is
  opened in Firefox before it is reported done, and `bench/m14-shell/firefox-drive.py` — which exists
  because a reader twice reported being unable to open anything on a green desktop — gains the file
  manager's gestures over `scripts/bidi.py`'s trusted input. **Firefox renders at dpr 1 on the
  reference machine**, which is why it catches a dpr-shaped defect that Chrome at dpr 2 hides, and
  also why a clause written against one ratio fails there for a reason that is not a defect.
- **A stray Chrome competing for the renderer.** `pkill -f "showup-chrome-"` between control runs. A
  twelve-control sweep without it reported a control BROKEN that passed alone.

---

## 6. What this plan does NOT do, and why that is acceptable

**It does not land A13, the change notification.** R32 is served by M21's F5 and a focus-triggered
re-read. A watch is the only item in the PRD that adds kernel state with a lifetime, and the
directory-fd `poll` answer must be corrected first — `src/kernel/calls.mjs:1330-1332` reports
`POLLIN|POLLOUT` for any directory fd, so a program that built a watch on `poll(dirfd, POLLIN, -1)`
never parks and spins a syscall loop at full rate. The precedent two branches above it is `F_DATA`
answering `POLLNVAL` expressly because an always-ready fallback made a poll-then-read loop spin
(`:1319-1329`). Acceptable because two windows on one folder that disagree is a defect a reader can
**fix with F5**, and a spinning watch is one they cannot see at all. R32 therefore owes no check and
no control in this plan, and the PRD's §8 says so rather than listing one that cannot run.

**It does not add Libraries, a network location, Control Panel, or a per-process memory column.**
The first is a userland convention over R5 and R27 and adds no primitive. The second cannot exist:
the only network path is kernel-side through the committed provider table
(`src/kernel/providers.mjs`), whose discipline exists because a caller-supplied URL would hand every
process an SSRF primitive. The third changes `WIN_CAP_H` and `WIN_INSET`, which are terms in the
kernel's blur accounting (D37), so it is a design question of its own. The fourth is impossible:
`performance.measureUserAgentSpecificMemory` is per agent cluster, so it reports one number for every
Worker together, and attributing it to whichever process asked is worse than nothing.

**It does not give the taskbar a second management endpoint.** D39 resolved that the other way and
M22 stays inside it: the shell is page-side and its **contents** are a process's published rows.
`--negative no-items` is the run that tells that apart from a page drawing a hard-coded menu.

**It does not retire the known second copies CLAUDE.md lists**, beyond the ones its own rows touch
(`src/bin/files.mjs`'s live metrics in M16, the surface sizing in M16, the extension table in M18).
`modeString` and `joinPath` in two files each, the nine pasted isolation gates in `www/*.html`, the
duplicated `class Serving`, and four hand-rolled CDP connects remain. Acceptable because each is a
drift with no reader-visible failure mode today, and `docs/designs/REVIEW-CODE-2026-11.md` carries the
addresses so none of them is lost.

**It does not reorder any milestone to get something visible sooner.** CLAUDE.md's Scope rule, and
M16 is visible anyway: the row a reader reported is fixed in the first row of the plan.

**And it finishes one milestone's proof and negative control before starting the next.** A milestone
without a failing-capable check is not done, however much of it is written.

---

## 7. Decisions this plan takes

Five questions the PRD's first draft listed as open are **decided here**, with the reason and the
cost, so neither document claims them open. The three that need a human are the PRD's §10 and are
not restated.

1. **The extension → program association is compiled in, at `src/libos/std.mjs`**, beside
   `FORMAT_BY_EXT` (`:278`) and `iconForPath` (`:315`), landing in M18. Reason: it matches the
   convention its two siblings already set, and R4 cannot wait for a persisted configuration format
   that does not exist. Cost: changing an association is a code change, and R24's pin list still
   needs a durable home — which is the PRD's §10.2 and stays open.
2. **The wheel coalesces in the kernel, in `Win.push`'s neighbourhood, not in the page.** Landing in
   M17. Reason: the kernel owns the queue and the drop, and a page-side coalescer would be a second
   opinion about a bound only the kernel knows. Cost: a kernel branch that inspects an event's type,
   which no other push does, and a `coalesced` counter to make it observable.
3. **The writable default location is `/desktop` on the root volume** (`src/bin/desktop.mjs:36`),
   landing in M20. `/usr` stays `EROFS`: its contents are a frozen array read in full at boot
   (`src/kernel/providerfs.mjs:28-99`, `:133-145`, `:180`), M20 needs *a* writable location and not
   *that* one, and installing a program is out of the PRD's scope. Cost: `/desktop` is user data
   rather than configuration, so it is the right home for files and the wrong one for R24's pins.
   **CORRECTED BY M19a: IT IS `/Users/Default`, AND IT IS A COPY OF THE WHOLE BASE.** This decision
   predates D40. Once the base is copied, a home-shaped tree is expressible and a bare `/desktop` is
   not one; the surface is Windows 7, so the shape is `C:\Users\<name>`, and the name is `Default`
   because every process runs as uid 0 and `src/abi.mjs` has no user table — a directory named after
   a user would be an account this system cannot name. `SEED_DEST` in `src/kernel/seed.mjs` and
   `HOME_DIR` in `src/libos/std.mjs` are the pair, compared on every boot by `www/shell.mjs`'s
   `seedState`. The desktop folder is `${std.sessionDir(env).dir}/Desktop`, created by the desktop
   process rather than by the seed. The decision is kept and corrected rather than edited, the way
   `docs/DECISIONS.md` §Corrections keeps its two. The cost sentence survives the correction intact:
   the session's tree is the right home for files and still the wrong one for R24's pins, which is
   the PRD's §10.2 and stays open.
4. **A13 does not land**; R32 is served by F5 and a focus-triggered re-read. §6 carries the reason and
   the cost in full.
5. **The breadcrumb (R28) waits for A8's metric table**, which lands in M19, two rows before M23
   needs it. Reason: CLAUDE.md's own finding — a geometry derived from a constant does not survive a
   second engine, and M11 and M12 each cost a milestone to exactly that. Cost: none, since the
   ordering already puts A8 first.

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
