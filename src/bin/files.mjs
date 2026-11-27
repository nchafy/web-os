// `files`: a window of file rows you can DRAG OUT of.
//
// The contract this program is written against is in src/bin/true.mjs.
//
// THIS IS HALF OF M10's HEADLINE AS A PROGRAM YOU CAN RUN — `imgview` is the other half. The
// milestone's claim is that bytes of a declared format cross from one process to another on a
// gesture, so there have to be two processes and a gesture:
//
//   files                       a row per file in the SESSION'S OWN TREE — the writable copy of
//                               the read-only base (`std.sessionDir`, D40)
//   press a row and drag it     onto `imgview`'s window. The row's bytes arrive there under the
//                               format this program declared, and the kernel owns the payload in
//                               between — so this process may exit mid-drag and the drop still
//                               lands (constraint 241)
//   files /some/dir             any directory
//
// WHAT IT OFFERS PER ROW: the PATH LIST always, and the file's own format from
// `std.formatForPath` — `.png` as PNG, `.rgba` as a bitmap, `.txt` as text. Which is to say the
// offer is a FILE ASSOCIATION, and it is one table in one place (`src/libos/std.mjs`).
//
// THE ROWS ARE TEXT, since `DL_TEXT` arrived in M15 (constraint 293): a small glyph, a name, and
// the type right-aligned. They were coloured BANDS with no name on them, because the display list
// had no text op — a column of amber and blue stripes, which a reader summarised as "the file
// system view is not correct". The band colour survives as the glyph's, so the amber a reader
// learned to read as "directory" is still amber.
//
// UNITS, AND THEY ARE THE WHOLE OF M16 (PRD §2). Every layout constant in this file is a CSS
// pixel, because a list view's metrics are what a reader reasons about. A SURFACE coordinate is a
// different unit: `win_surface` is asked for DEVICE pixels, and `WEV_CLIENT` is a program's only
// route to the ratio between them. So the factor `S` exists once, is applied once — in `px`, on
// the way into the display list — and the device-px box becomes CSS px at exactly one boundary, in
// `relayout`. Before this, `SURFACE_W = 420` was handed to `win_surface` unconverted: one integer
// in two units, which on a dpr-2 display is a 420-pixel picture stretched over an 856-pixel client
// area, and which no amount of resizing could ever sharpen.
//
// M17: IT SCROLLS, AND THE VIEWPORT IS CLIPPED. `WEV_WHEEL` moves a scroll offset and `DL_CLIP`
// bounds what a row may paint to the list area below the header. Both halves are needed: a row
// scrolled half out of the top paints over the header without the clip, and the row after the last
// visible one paints past the bottom edge. The offset CLAMPS at both ends, so a wheel at the top of
// the list and a wheel at the bottom of it both stop rather than running the content off the window.
//
// THE WHEEL'S DELTAS ARE SURFACE PIXELS (constraint 248), like `WEV_POINTER`'s coordinates, so they
// divide by `S` on the way in — the same border `cssPointAt` is on, and the same unit error M16
// cost a milestone for. `WWHEEL_PAGE` says the delta is in PAGES instead, and a page here is the
// viewport's own height.
//
// WHAT THE SCROLL REPLACES: the row CAP and the "+N more" line constraint 294 required. That
// constraint's premise was that the window ABI delivered no wheel, so a scrollbar would be a control
// this program could not receive input for; `WEV_WHEEL` removes the premise. The remainder is now
// REACHABLE rather than stated, and the header names which rows are on screen so a reader still
// knows where in the list they are. There is still no scrollbar, for the unchanged half of the
// reason: a thumb is dragged, and a drag on one would be a gesture this program cannot route.
//
// M18: IT NAVIGATES, AND A ROW OPENS. Three pieces, and they are separate on purpose:
//
//   THE KEYBOARD CURSOR is `focus`, moved by `WKEY_UP`/`WKEY_DOWN`/`WKEY_HOME`/`WKEY_END` and the
//   two Page keysyms — a `WEV_KEY` with no bytes, which this program could not receive before M18
//   because `src/wm/winhost.mjs` dropped every key `bytesForKey` could not spell. It is NOT the
//   selection: a press on the header clears the selection and must not clear the reader's place in
//   the list, so the two are drawn differently and one can outlive the other. Moving it SCROLLS to
//   it, because a cursor outside the viewport is a cursor on a row nobody can see.
//
//   THE ACTIVATION VERB is a DOUBLE-CLICK or Enter on the cursor. A single click only selects, and
//   that is a real distinction rather than a convention: `WPTR_CLICK2` rides the DOWN record only,
//   so the second click is the one place it can be read. A directory RE-LISTS IN THIS WINDOW — new
//   rows, a title naming the child, the offset and the selection reset because they belonged to the
//   directory that is gone. A file spawns the program `std.openerForPath` names, with the argv the
//   association carries: `imgview` wants `-f PATH` and `editor` wants a bare path, and a caller
//   that guessed would hand one program the other's operand.
//
//   BACK is Alt+Left or Backspace, because Windows 7 binds Backspace to Back and has no Up button.
//   The history is a stack of directories and going back from the bottom of it is a REFUSAL — by
//   name and counted, like every other thing this program declines to do.
//
// NOTHING IS FOCUSED AT STARTUP OR AFTER A RE-LIST, and `activate(-1)` refuses rather than opening
// row 0. A first Enter that opened the first row would be this window acting on a choice the reader
// never made, which is the same defect as a double-click that silently does nothing — so both ends
// of it are counted in `refused` and named in `refusals`.
//
// M19: IT IS A DETAILS VIEW. Four columns, a sort a reader chooses, a selection of more than one
// row, and a lit row under the pointer. Five pieces, and the first of them pays for the rest:
//
//   EVERY ROW IS `lstat`ED, DIRECTORIES INCLUDED. The call used to sit inside `if (!dir)`, so a
//   folder had no size, no modification time and no execute bit — and a Date modified column with
//   an empty cell on every folder is a column that is lying about half its rows. A FOLDER'S SIZE
//   CELL IS STILL EMPTY, and that is the distinction: a directory's `st_size` is the size of its
//   own entry table, which is not what a reader asked, so it is drawn as nothing on purpose while
//   the date beside it is drawn because the call was paid.
//
//   THE COLUMNS ARE DATA (`COLUMNS`), and their geometry is `columnBoxes` — one function, read by
//   the header, by every cell, by the sort's hit test and by anything outside the process that
//   wants to aim at a column. `columnAt` is its declared inverse, which is what makes a press land
//   on the column a reader sees.
//
//   A HEADER CLICK CHOOSES THE SORT AND A SECOND CLICK ON THE SAME COLUMN REVERSES IT. The opening
//   order is name-ascending and nobody chose it, so the first click on the `Name` header is a
//   CHOICE and not a reversal: a reader looking at an ascending list who clicks `Name` expects what
//   they are looking at, not its opposite. DIRECTORIES STAY FIRST either way, and the NAME is the
//   secondary key ASCENDING either way — so the order within a group of equal dates or equal types
//   does not depend on which way the primary sorted, which is the whole of what "stable" means
//   here. A RE-LIST RESETS IT, for the reason `relist` resets everything else: a directory opened
//   from the command line and the same directory navigated into must show the same rows in the same
//   order, or row 1 is decided by a reader's history with a directory that is gone.
//
//   THE SELECTION IS A SET, WITH AN ANCHOR. A plain press replaces it and moves the anchor;
//   Ctrl+press TOGGLES one row and MOVES THE ANCHOR THERE (so the next Shift+press ranges from the
//   row the reader last touched); Shift+press selects the range between the anchor and the press in
//   LAYOUT order. Layout order is index order in this program because the sort reorders `rows`
//   ITSELF rather than an index beside it — which is the one design in which the two cannot
//   disagree, and the reason there is no separate "display order" to get wrong.
//
//   A RUBBER BAND COMES FROM EMPTY SPACE AND A DRAG COMES FROM A ROW. That arbitration is taken at
//   the press, once, from `rowUnder` alone: a press that found a row arms the drag threshold, a
//   press that found none arms the band. Nothing downstream re-decides it, because a gesture that
//   could become either depending on how far the hand moved is a gesture that publishes a file the
//   reader never touched.
//
//   A LIT ROW IS THE HOVER, AND IT IS A BAND AND NOT AN INK. A pointer record with neither button
//   bit and no buttons held is a hover (`WPTR_LEAVE`'s docstring in src/abi.mjs); `WPTR_LEAVE`
//   clears it, because the last hover a window ever gets is the one nearest the edge and a lit row
//   with the pointer gone is a lie. It is drawn as a fill UNDER the row's text rather than as a
//   different ink, so "which row is lit" and "which row is selected" stay two readings — the
//   selection is the only thing that changes a name's colour.
//
// M20: IT MUTATES THE FILESYSTEM, AND IT RAISES A MENU IT DOES NOT DRAW. Six verbs and two menus.
//
//   THE SIX VERBS ARE REAL SYSCALLS AND NOTHING ELSE. New folder is `mkdir`, rename is `rename`,
//   Delete is `unlink` for a file and `rmdir` for a directory — M21 made that the case where there
//   is no Bin to reach, and the reasoning below is unchanged for it — Copy and Cut publish a
//   `DOBJ_PATHS` object to the ONE clipboard, and Paste reads it back and either copies the bytes or `rename`s
//   the inode. Each one is followed by a fresh `readdir` (`reread`), so what the window shows is
//   what the filesystem now holds rather than what this program believes it did — a listing patched
//   in place would make a refused `mkdir` indistinguishable from one that worked.
//
//   THE DESTINATION IS CHECKED BEFORE A MOVE AND NOT BEFORE A COPY, and the asymmetry is the two
//   calls' own contracts. `rename(2)` REPLACES an occupied destination (`src/fs/vfs.mjs`), so the
//   only place a file manager can refuse that is here, before the call; a copy opens with
//   `O_CREAT | O_EXCL` and the KERNEL answers EEXIST, which has no race in it. The pre-check does,
//   and says so where it is written.
//
//   THERE IS NO READ-ONLY CASE IN THE DIRECTORY A READER LANDS IN. D40 and M19a made the session a
//   writable copy of the read-only base, so a branch for "the default directory refuses" would be a
//   branch no check can reach. THE READ-ONLY MOUNTS STILL EXIST — `files /usr/share` opens one, and
//   a reader browsing `Computer` reaches it — so every verb REFUSES BY NAME THERE with the errno the
//   kernel gave it, which is `refuse`'s third argument and is asserted per verb rather than as one
//   "it refused" (M3's `truncate` answered ENOENT where it owed EROFS).
//
//   CUT/COPY/PASTE USE THE SYSTEM CLIPBOARD AND NOT A SLOT OF THEIR OWN. `src/kernel/dataobj.mjs`
//   owns the one slot and refcounts the payload (constraints 240-242), so a Copy here is a Paste in
//   `clip`, and a Cut survives this process exiting. WHAT DOES NOT CROSS IS THE INTENT: a published
//   object is SEALED and `dataobj_set` on it answers -EPERM by design, and the record carries no
//   "this was a cut" field — so the move/copy intent is THIS PROCESS'S state, and a Cut in one
//   `files` window pasted in another is a COPY. That is a limit of the ABI and it is stated rather
//   than worked around; a second clipboard here would be the drift.
//
//   THE MENU IS RAISED AND NOT DRAWN. `win_menu` hands the kernel the rows `encodeWinItems` already
//   defines and the page draws the popup, because `.window-body` is `overflow: hidden`
//   (`src/wm/aero.mjs`) — a menu a process painted into its own surface loses every row past the
//   frame's edge, and a context menu near the bottom of a window is exactly that case.
//   `--menu-in-surface` is that world, kept as a control.
//
//   TWO MENUS, AND WHICH ONE IS DECIDED BY `rowUnder` AT THE PRESS — the same arbitration the drag
//   and the band already take there, for the same reason: a gesture that re-decided downstream is a
//   gesture that deletes a file the reader never pointed at. A right press on a row that is NOT
//   selected selects it first, and one on a row that IS keeps the whole selection, which is what
//   makes "Delete" mean the rows a reader can see highlighted.
//
//   A RIGHT PRESS IS `event.buttons`' SECONDARY BIT, carried in a `WEV_POINTER`'s `c`
//   (`pointerAt`'s `buttons`). There is no `WPTR_*` bit for a button: the record already carries
//   the browser's mask, and a second spelling of it in `mods` would be two fields to disagree.
//
//   CTRL+X/C/V AND CTRL+N ARRIVE AS BYTES, NOT KEYSYMS. `bytesForKey` turns a Ctrl chord into its
//   C0 byte (`src/wm/terminal.mjs`), so Ctrl+X is 24, Ctrl+C is 3, Ctrl+V is 22 and Ctrl+N is 14 —
//   and `keysymOf` answers 0 for every one of them. A program that waited for a keysym here would
//   wait for ever. F2 and Delete ARE keysyms, because no byte spells them.
//
// M21: A DELETE IS RECOVERABLE, F5 RE-LISTS, AND A DROP LANDS HERE. Four pieces.
//
//   THE BIN IS A RESERVED DIRECTORY AND A DELETE LEAVES TWO RECORDS IN IT: the payload, moved by
//   one `rename`, and an ORIGIN RECORD beside it — a SYMLINK whose target is the absolute path the
//   payload came from. `bench/m21-bin/probe.mjs` is why it is a symlink and not a file of bytes,
//   measured over 26,403 torn cases: `vfs.symlink` stores the target verbatim in ONE journal
//   record, and a journal record carries a CRC-32 (`src/fs/journal.mjs`) while an OPFS blob carries
//   none (`src/kernel/store.mjs` has no checksum field at all). So an origin path held as a symlink
//   target has the same integrity field as the rest of the volume and is inside `scripts/fsfuzz.py`'s
//   three-second gate; the same path held as file data is neither, and a bit-rotted origin would be
//   undetectable. There is NO NEW FILESYSTEM CONCEPT and no inode flag.
//
//   THE PAYLOAD KEEPS ITS OWN NAME, numbered when the Bin already holds one — `freeFrom`, the same
//   function New folder uses, with the origin record's name RESERVED beside it. A Bin whose rows
//   were ids would need a name translation in the listing, and a translation is the one place a
//   file manager can show a reader the wrong file.
//
//   THE LISTING IS A `readdir` OF THE BIN WITH THE ORIGIN STORE AS A LOOKUP, NEVER THE REVERSE.
//   The payload entries ARE the rows and `readlink` answers where each came from; inverting the
//   join turns 1,125 of the probe's cases from visible to INVISIBLE — bytes a reader can neither
//   see nor reclaim. An origin record with no payload is therefore not a row: it names nothing a
//   reader can act on, carries no bytes, and is counted rather than drawn.
//
//   THE TWO ORDERS, AND ONLY ONE OF THEM IS A JUDGEMENT. A DELETE writes the origin record first
//   and moves the bytes second (`origin-first`: 0 unrestorable rows against 1,260 stranded
//   records; `payload-first` is 1,125 against 0 — both recoverable, and this half-state shows the
//   reader nothing wrong). A RESTORE IS FORCED THE OTHER WAY: the bytes go home first and the
//   record is dropped second, because the other order left 1,260 of 2,017 torn cases with bytes in
//   the Bin that nothing names — and the one fact needed to repair that is the fact that was lost.
//   It is the only irreversible half-state the whole measurement found, and it is in restore.
//
//   A RESTORE ONTO AN OCCUPIED PATH IS REFUSED HERE, BY NAME, BECAUSE THE FILESYSTEM WILL NOT DO
//   IT. `vfs.rename` has no `RENAME_NOREPLACE`: over a plain file it refuses nothing — `applyOp`'s
//   RENAME arm deletes the standing entry, decrements nlink and FREES the inode, measured in one
//   journal record (`renameRefused: null`, `freedInode: 8`, `clobbered: true`). A restore that
//   trusted the call would destroy a file the reader made in the meantime, silently. The `lstat`
//   races, which is `commitRename`'s trade written down again rather than hidden.
//
//   A DELETE OUTSIDE THE SESSION TREE IS PERMANENT AND SAYS SO. The Bin is `std.HOME_DIR`'s, so a
//   row on a read-only mount or in `/tmp` has nowhere recoverable to go: a cross-volume Bin would
//   be a `rename` the filesystem refuses, and a second Bin per mount is a second place to look for
//   a file. So `/usr/share` still answers EROFS by name and `/tmp` still deletes finally, which is
//   also what Windows does with a volume that has no Recycle Bin. A delete INSIDE the Bin is
//   permanent for the same reason: that is where "where did it go" has already been answered.
//
//   F5 RE-LISTS AND THE SELECTION SURVIVES FOR THE ROWS THAT SURVIVE. It is `reread`, which M20
//   already restores a selection BY NAME with — so a selected row that is gone is simply not
//   re-selected, rather than resurrected or crashed into. An index would be the defect: a mutation
//   is exactly what moves index order.
//
//   A DROP LANDS WHERE THE POINTER IS, AND IT IS ALWAYS A COPY-IN. `WEV_DROP` carries the position
//   and the OFFER and nothing else — there is no effect field and no negotiation (constraint 240) —
//   so a target that renamed would be deciding an effect the SOURCE negotiated. The source
//   completes a move when the kernel tells it the effect was one, which is the division the ABI
//   already has. A drop on a DIRECTORY ROW lands in that directory; anywhere else in the viewport
//   lands in the open one.
//
//   THE MODIFIER DECIDES THE EFFECT A DRAG OFFERS, AND SO DOES WHERE THE ROW IS. Ctrl forces a
//   COPY. Without it a row INSIDE THE SESSION TREE offers a MOVE and a row outside it still offers
//   a COPY — because a MOVE source cannot verify the collection (a queued drop reports its effect
//   whether or not the target took the bytes, constraint 245), so the original goes TO THE BIN and
//   not to `unlink`, and the Bin is the session tree's. No Bin, no safe move. That is also why
//   `files /usr/share` — M10's own source window — still reports COPY for a plain drag: a move off
//   a read-only mount is not a thing this program could complete.
//
// M23: A ROW'S ICON IS THE FILE, AND THE FALLBACK IS THE ICON IT ALREADY HAD.
//
//   A THUMBNAIL IS THE FILE'S OWN BYTES, DECODED IN THIS PROCESS. `DL_BLIT` names a data-object fd
//   and draws the payload WHOLE at its own `BMP_W`/`BMP_H` in surface px — there is no destination
//   size and no scaling in the renderer (`src/wm/surface.mjs`) — so the DECODE is what fits a
//   picture to a cell, and the payload's extent is a function of the display's ratio. A cache keyed
//   on the path alone would blit a half-size picture at dpr 2, which is `--no-resurface`'s defect
//   one layer down; `thumbFit` and the cache key are where that is handled.
//
//   THE DECODE IS AWAITED, AND WHERE IT HAPPENS IS THE DESIGN. `bench/m23-blit/` measured that
//   `createImageBitmap` is present AND usable inside a locked-down realm under M6's live CSP, with
//   the pixels byte-exact against `/usr/share/logo.rgba` in two engines — but only in an AWAITED
//   turn. Not while parked in a syscall, not while spinning, and a cold decode needs seven macrotask
//   turns. So `run` is async, the decodes happen BEFORE the poll, and `paint` never decodes: a
//   repaint that evicted an object whose fd it had already written into the batch would have the
//   whole `win_draw` refused -EBADF.
//
//   THREE CEILINGS BOUND IT AND ONE OF THEM IS VISIBLE. `DOBJ_MAX_BYTES` fixes the largest square a
//   payload can be (511 device px — eight bytes short of the Extra Large cell at dpr 2, so the
//   clamp is real and counted); `THUMB_SOURCE_MAX` is the largest file read whole to make a picture
//   of it; and `DOBJ_CAP` is a PER-PROCESS object count, which leaves 28 live thumbnails after the
//   reserve the clipboard and a drag need. A view with more tiles than that draws the TYPE ICON on
//   the remainder and says how many — because `DL_BLIT` has no source rectangle, so an atlas is
//   unexpressible and one picture costs one object.
//
//   A FALLBACK IS NOT A REFUSAL. `refuse` is for something a reader asked for; a thumbnail nobody
//   requested that degraded to the icon the row would have had anyway is a statement about a
//   picture. It is counted in `account.thumbs` with the reason per path, and never in
//   `account.refusals` — where it would be indistinguishable from a refused Delete.
//
// WHAT THIS PROGRAM DOES NOT DO WITH `/dev/advance`: it does not read it. A column's width here is
// a CSS-px constant, and the table is indexed in SURFACE px — so a column fitted to its widest cell
// would be a width that moved with the display's ratio, which is the ratio-shaped defect that cost
// M11, M12 and M16 (CLAUDE.md). A cell that does not fit its column is handed to the renderer as
// `DLT_ELLIPSIS` plus the column's width in surface px, which is where the ABI puts that decision:
// a program must not pre-cut, and a sum of published advances is only an upper bound for a
// proportional run anyway (`advanceWidth` in src/abi.mjs).
//
// `--no-drain MS` IS A FIXTURE AND NOT A CONTROL, which is why it is documented apart from the two
// below. It holds the event loop for MS milliseconds before the first poll, so a notch stream longer
// than `WIN_EVENT_CAP` laps a queue nobody is draining — the state the kernel's wheel coalescing is
// proven in, and the state an uncoalesced stream drops its NEWEST record in. It breaks nothing by
// itself: when the hold ends the program drains the queue and applies the whole summed delta, which
// is the clause the proof asserts. The precedent for a shipped flag whose only job is to put the
// system into a state a check needs is `cfg.blurBudgetPx` and `scripts/serve.py --no-isolation`.
//
// FOURTEEN FLAGS EXIST ONLY TO BREAK THAT, as negative controls a check can re-run rather than source
// mutations nobody re-runs (the precedent is `scripts/serve.py --no-isolation`):
//
//   --no-resurface      ignore `WEV_CLIENT` entirely. The pre-M16 program exactly: a backing store
//                       that never follows its window, so a resize CSS-stretches a 420 px list
//                       over however much room the reader just made. The reported defect, restored.
//   --css-px-surface    refit, but ask for the client box in CSS pixels and leave `S` at 1 — the
//                       unit error on its own, with the resize path working.
//   --unclamped-scroll  accept an offset past the END of the list. M17's clamp control: the list
//                       scrolls into blank paper below its last row and nothing refuses. The TOP
//                       clamp stays — removing both costs a clause this control is not about, and
//                       the harness said so. It counts no bottom clamp, because a clamp that did
//                       not happen must not be reported as one.
//   --stable-sort-off   let the secondary key follow the sort's DIRECTION — `dir * (byKey ||
//                       byName)`, which is the naive spelling. Names then descend inside a group of
//                       equal dates or equal types whenever the primary descends, so the order
//                       within a group depends on which way the reader last clicked. The ONLY
//                       clause it moves is the stable-order one: the primary key still sorts and
//                       still reverses.
//   --folders-last      put directories after files instead of before them. "Directories stay first
//                       whichever way it sorts" is the clause; this is its world.
//   --no-dir-stat       skip the `lstat` for a DIRECTORY, which is the call that used to be missing.
//                       A folder's Date modified cell goes empty and its Size cell — empty either
//                       way — does not move, so the clause this breaks is the one that proves the
//                       directory stat is paid rather than the one that proves the size is omitted.
//   --band-from-row     start a RUBBER BAND from a press on a row. The arbitration removed: the
//                       drag never begins, and dragging across rows selects them instead of
//                       publishing the pressed one.
//   --menu-in-surface   DRAW the context menu into this window's own surface instead of calling
//                       `win_menu`. M20's third control, and the world constraint-226's division
//                       exists to prevent: `.window-body` is `overflow: hidden`, so the popup
//                       cannot extend past the frame and a menu raised near the bottom edge loses
//                       its last rows. No `win_menu` reaches the kernel either, so `menus` stays 0.
//   --paste-clobbers    let a Paste REPLACE a name that is already here: the move's destination
//                       pre-check goes and the copy drops `O_EXCL`. The clause asserting the EEXIST
//                       refusal MUST fail, and this is the one world in which a reader's own file is
//                       destroyed by a paste that reports success. It reaches a DROP too, because
//                       `landOne` is one landing reached by two gestures and the decision — may a
//                       landing replace a file — is one decision.
//   --bin               open the Bin instead of the session tree. NOT a control and NOT a fixture:
//                       it is how the desktop's Recycle Bin row launches this program, because the
//                       row names the LOCATION and where that location is belongs to this file.
//   --restore-overwrites  let a Restore clobber an occupied origin path: the userland pre-check
//                       goes and `vfs.rename` frees the occupant's inode, measured. The clause
//                       asserting the refusal MUST fail, and the reader's own file is destroyed by
//                       a restore that reports success.
//   --move-forced-copy  offer `DOBJ_EFFECT_COPY` whatever the modifier and wherever the row is. The
//                       effect clause MUST fail alone: the gesture still runs, the drop still
//                       lands, and the source is still there afterwards when it should not be.
//   --stale-listing     serve the rows already in hand on F5 instead of re-reading the directory.
//                       The F5 content clause MUST fail alone — the keysym still arrives and is
//                       still counted, so what moves is what the window SHOWS.
//   --no-thumbs         decode nothing. M23's first control: every row keeps its type icon, so the
//                       clause asserting a picture made of a file's own bytes MUST fail while the
//                       fallback clause beside it MUST hold — `wanted` stays where it was and
//                       `decoded` goes to 0, which is what tells this world apart from a directory
//                       with nothing to decode.
//   --thumb-no-fallback decode, and draw NOTHING for a row whose decode was refused, capped or
//                       barred. The silent-blank world: the clause asserting that a row with no
//                       thumbnail still has an icon MUST fail, and the thumbnails that DID decode
//                       are unmoved — so the control is scoped to the fallback alone.
//
// None belongs on a prompt. A reader who passes one gets the bug the milestone removed.

import {
  POLLIN, POLLHUP, POLLERR, POLLNVAL, EINTR, EINVAL, EEXIST, ENOTDIR, EHOSTGONE,
  DT_DIR, DT_LNK,
  NAME_MAX,
  WEV_KEY, WEV_POINTER, WEV_CLOSE, WEV_DESTROYED, WEV_RESIZE, WEV_FOCUS, WEV_DRAG_DONE,
  WEV_DRAG_ENTER, WEV_DRAG_LEAVE, WEV_DROP,
  WEV_CLIENT, WEV_ITEM, WPTR_DOWN, WPTR_UP, WPTR_CLICK2, WPTR_LEAVE,
  clientBoxAt, keyBytesOf, keysymOf, itemAt,
  WKEY_LEFT, WKEY_RIGHT, WKEY_UP, WKEY_DOWN, WKEY_HOME, WKEY_END,
  WKEY_PAGE_UP, WKEY_PAGE_DOWN,
  WKEY_F2, WKEY_F5, WKEY_DELETE,
  WMOD_ALT, WMOD_CTRL, WMOD_SHIFT,
  WITEM_CONTEXT, WITEM_SEPARATOR, WITEM_DISABLED, WITEM_CONTAINER,
  WICON_GENERIC, WICON_FOLDER, WICON_TRASH,
  WEV_WHEEL, WWHEEL_PAGE, WWHEEL_COALESCED, wheelAt,
  DL_CLEAR, DL_FILL_RECT, DL_STROKE_RECT, DL_CLIP, DL_MAX_OPS,
  DLT_BOLD, DLT_MONO, DLT_RIGHT, DLT_ELLIPSIS, DLT_CENTER, encodeTextRun,
  encodeBlit, encodeBitmap, decodeBitmap, BITMAP_HEADER,
  DOBJ_PATHS, DOBJ_TEXT, DOBJ_PNG, DOBJ_BITMAP, DOBJ_MAX_BYTES, DOBJ_CAP,
  DOBJ_EFFECT_COPY, DOBJ_EFFECT_MOVE, DOBJ_WHERE_CLIPBOARD, DOBJ_WHERE_DROP,
  O_RDONLY, O_WRONLY, O_CREAT, O_EXCL, S_IFMT, S_IFDIR, fmtName, fmtsOf,
} from "/src/abi.mjs";

const NAME = "files";

/** Where a program lives. Restated from `src/bin/sh.mjs`'s `DEFAULT_PATH` and
 *  `src/bin/desktop.mjs`'s `BIN_DIR`, which is a second copy this file cannot remove: the one
 *  definition would have to be in `src/libos/std.mjs`, and that file is not this change's. */
const BIN_DIR = "/usr/bin";

/* THE TWO BYTE KEYS THIS PROGRAM BINDS. They are BYTES and not keysyms — `src/wm/terminal.mjs`'s
 * `bytesForKey` turns Enter into 10 (line feed, not carriage return) and Backspace into 127 (DEL),
 * and `KEYSYM_BY_KEY` deliberately has no row for either, so `keysymOf` answers 0 for both. A
 * program that waited for a keysym here would wait for ever. */
const KEY_ENTER = 10;
const KEY_BACKSPACE = 127;

/* M20's BYTE KEYS, AND THEY ARE BYTES FOR THE SAME REASON. `bytesForKey` turns a Ctrl chord into
 * its C0 byte (`src/wm/terminal.mjs`) and gives Escape 27, and `KEYSYM_BY_KEY` has a row for none
 * of them — so `keysymOf` answers 0 and a program that waited for a keysym here would wait for
 * ever. The letter is recoverable from the byte: Ctrl+A is 1, so Ctrl+N is 14, Ctrl+C is 3, Ctrl+V
 * is 22 and Ctrl+X is 24. */
const KEY_ESCAPE = 27;
const KEY_CTRL_C = 3;
const KEY_CTRL_N = 14;
const KEY_CTRL_V = 22;
const KEY_CTRL_X = 24;
/** M23's two: Ctrl+E is 5 and Ctrl+F is 6, by the same `c - 64` arithmetic. BOTH open the search
 *  field, because Windows 7 binds both — Ctrl+E was Explorer's and Ctrl+F is every other program's,
 *  and a reader who knows one should not have to learn the other. */
const KEY_CTRL_E = 5;
const KEY_CTRL_F = 6;

/** The SECONDARY button in a `WEV_POINTER`'s `c`, which carries the browser's `event.buttons` mask
 *  verbatim (`pointerAt`). Named here because the ABI has no `WPTR_*` bit for a button: the mask is
 *  already in the record and a second spelling of it would be two fields that can disagree. */
const BTN_RIGHT = 2;

/** The last printable byte this program accepts into a rename field, and the first. A key outside
 *  the range is ignored rather than typed: a C0 byte in a filename is a filename no reader can
 *  retype, and `nameFault` refuses a NUL on the way out as well. */
const PRINTABLE_LO = 0x20;
const PRINTABLE_HI = 0x7e;

const POLL_MS = 200;
const CEILING_MS = 300000;

/* THERE IS NO DEFAULT DIRECTORY CONSTANT HERE. It was `/usr/share` — a READ-ONLY provider mount,
 * which is the whole of what D40 fixed: every mutating verb M20 adds would have been unreachable
 * from the one directory this program showed. The default is now the session's own tree, resolved
 * by `std.sessionDir` — one definition, beside the other userland conventions, read by this program
 * and by `src/bin/desktop.mjs`. */

/* ONE ROW, IN CSS PIXELS — the unit a list view's metrics are reasoned about in, and the unit
 * every constant below shares. A surface coordinate is `S` times one of these and is produced
 * nowhere but `px`.
 *
 * The geometry is a list view's: a header row, then one row per entry, each with a small glyph, a
 * name, and the type right-aligned. */
const ROW_H = 20;
const ROW_GAP = 2;
const PAD = 6;
/**
 * M23: THE ADDRESS STRIP, CSS px — the breadcrumb, the search field and the view button (R28, R31,
 * R27).
 *
 * IT IS BELOW THE COLUMN HEADER AND NOT ABOVE IT, AND THAT IS A DELIBERATE DEPARTURE FROM WINDOWS
 * 7, RECORDED HERE BECAUSE THIS IS WHERE A READER MEETS IT. Explorer's order is address bar, then
 * column headers, then list. This program's is column headers, then address strip, then list. The
 * reason is a reading in a file this slice does not own: `www/m19.html`'s `caretOf` finds the sort
 * wedge by filtering the batch for fills with `op.a1 <= px(4)` — "the top four CSS pixels of the
 * client area, where nothing else in the header is" — so an address strip ABOVE the header pushes
 * the wedge out of that window and turns three of M19's clauses red over a program drawing it
 * correctly. MEASURED: with the strip on top, `--only m19` reported `caret: None` on all three.
 *
 * THE ONE-LINE CHANGE THAT WOULD LET IT MOVE is `caretOf`'s y window, from `[0, px(4)]` to
 * `[px(FILES_METRICS.CRUMB_TOP), px(FILES_METRICS.CRUMB_TOP + 4)]` — which is why `CRUMB_TOP` is
 * exported. Until then the strip is where it is and the order is wrong rather than the wedge.
 *
 * `CRUMB_H < HEAD_H` IS AN INVARIANT EITHER WAY AND IT IS LOAD-BEARING OUTSIDE THIS PROCESS. The
 * one point anything outside this program uses to mean "above the viewport" is
 * `FILES_METRICS.VIEW_TOP / 2`, and three proof pages aim real input at it — `www/m18.html`'s
 * `pointAtHeader`, `www/m19.html`'s column press, `www/m20.html`'s `pointOnHeader`. With the
 * COLUMN band first, that point is in it exactly when `VIEW_TOP / 2 < HEAD_H`, which reduces to
 * `CRUMB_H < HEAD_H`; the margin is `(HEAD_H - CRUMB_H) / 2`, three CSS px today, and
 * `HEAD_H = 22` would have left none. `HEADER_MID` and `CRUMB_MID` are exported so a driver names
 * a band instead of halving `VIEW_TOP`.
 */
const CRUMB_H = 22;
/** How far inside the address strip a segment's text sits, and the gap between two segments. */
const CRUMB_PAD = 4;
/**
 * THE WIDTH OF ONE MONOSPACED CHARACTER AS A FRACTION OF THE FONT SIZE — and it is a MEASUREMENT,
 * which is what makes the breadcrumb's hit rectangles honest (PRD A8: "segment hit rectangles need
 * measured widths").
 *
 * THE MONO ADVANCE IS EXACTLY LINEAR IN THE SIZE AND THE PROPORTIONAL ONE IS NOT. Over the eleven
 * sizes `TEXT_SIZES` declares, `ADVANCES.adv.mono`'s advance divided by its size is 0.602050 to
 * 0.602055 — a spread of 5e-6 — while `ADVANCES.adv.ui`'s runs from 0.68555 at 10 px to 0.64160 at
 * 22 px, a 6.4% spread (read out of `src/kernel/advance.mjs` with
 * `node -e "import('./src/kernel/advance.mjs')…"`). THAT IS WHY THE SEGMENTS ARE MONOSPACED: a
 * width derived from a PROPORTIONAL advance moves with the display's ratio, because the table is
 * indexed in SURFACE px and a 12 CSS px run is 24 surface px at dpr 2 — which is the ratio-shaped
 * defect this file's header refuses to take on for a column, and refuses for the right reason. A
 * MONO width does not move, so it can be a CSS-px constant.
 *
 * 0.603 AND NOT 0.60205, because this is an UPPER bound: the box bounds the run (`DLT_ELLIPSIS`),
 * so slack leaves a glyph short of its edge and a deficit would let the renderer cut a name the box
 * claimed to hold. The cross-engine worst disagreement in that table is 0.0208 px for anything but
 * the space, so three thousandths is ample for Firefox too.
 */
const MONO_ADVANCE_PER_PX = 0.603;
/** THE SEARCH FIELD'S WIDTH, CSS px, at the right of the address strip — Explorer's own place for
 *  it. Fixed rather than proportional, because a field that shrank with the window would stop
 *  holding a query a reader could read back. */
const SEARCH_W = 132;
/** THE VIEW BUTTON, CSS px: a square at the far right of the address strip that steps the view
 *  mode. It exists because Ctrl+wheel is otherwise the ONLY gesture route to a mode — Windows'
 *  Ctrl+Shift+1..7 cannot reach a program here (`bytesForKey` answers null for a Ctrl chord that is
 *  not a C0 letter), so a reader with no wheel would have no route at all. */
const VIEWBTN_W = 26;
/** The column header, and it is still the TOP band of the client area.
 *
 *  M23 RAISED IT FROM 22 TO 28, which is two things at once: a 28 px header is what Windows 7's own
 *  column header is, and it is what gives `CRUMB_H < HEAD_H` its margin (see `CRUMB_H`). */
const HEAD_H = 28;
/** WHERE THE ADDRESS STRIP STARTS, CSS px — below the column header. Exported, because it is the
 *  offset `www/m19.html`'s `caretOf` would need to move the strip above the header (see
 *  `CRUMB_H`). */
const CRUMB_TOP = HEAD_H;
/**
 * THE PAPER LEFT BETWEEN THE STRIP'S PLATE AND THE VIEWPORT'S TOP EDGE, CSS px.
 *
 * THE VIEWPORT'S EDGE HAS TO BE PAPER AND NOT THE PLATE. A row scrolled half under the header is
 * CUT by the `DL_CLIP`, and what makes that cut visible is the colour on the other side of it: a
 * dark plate butted against the clip would hide the cut, so a reader could not tell a row the clip
 * removed from a row that is not there. `www/m17.html` reads exactly that pixel — one surface row
 * above the clip — and asserts it is the batch's own `DL_CLEAR` colour, which is the same fact
 * stated as a check.
 */
const CRUMB_SKIRT = 2;
/** THE STATUS STRIP, CSS px: the bottom line of the client area, below the viewport, carrying the
 *  position statement M17 added and the selection count M19 did. It is Windows 7's status bar, and
 *  it exists because a header holding four column labels has no room left for a sentence.
 *
 *  IT IS DRAWN BEFORE THE `DL_CLIP`, with the header, and that is load-bearing rather than tidy: a
 *  clip bounds the VIEWPORT, this sits below it, and a canvas clip only ever intersects — so a
 *  footer drawn after the clip would be cut away entirely. */
const FOOT_H = 20;
/** The glyph box at the left of a row: a folder or a page, drawn out of rectangles. */
const GLYPH_W = 16;
/** Where the name starts. A fixed inset, so it does not follow the window. */
const NAME_X = PAD + GLYPH_W + 8;
/** How far inside the padding the LAST column's right edge sits — the type column's own inset
 *  until M19 gave it three neighbours. The columns are laid out from the LIVE width, so this is an
 *  inset and not a position. */
const TYPE_INSET = 4;
const TEXT_PX = 12;
/** Text sits this far below a row's top, which centres a 12 px run in a 20 px row. */
const TEXT_DY = 4;
/** The width the window OPENS at, CSS px. It is a guess and nothing reads it afterwards: the first
 *  `WEV_CLIENT` replaces it with the measured client box. */
const START_W = 420;
/** How many rows the window OPENS tall. 24 rows plus a header is about 560 CSS px, which fits the
 *  work area on the smallest screen this has been opened on and leaves the taskbar reachable. It
 *  decides the OPENING HEIGHT ONLY and caps nothing: the list scrolls, so a longer directory is
 *  reachable at this height and a taller window shows more of it at once. */
const START_ROWS = 24;

/** One row's pitch: its height plus the gap under it. The whole of the scroll arithmetic. */
const ROW_STRIDE = ROW_H + ROW_GAP;
/** The top of the CLIPPED viewport, CSS px — below the header rule at `VIEW_TOP - 4` and above the
 *  first row at `VIEW_TOP + PAD`, so a row scrolled under the header is cut here and the rule and
 *  its padding stay visible. It is the clip's edge and not a row's, which is why it is its own
 *  constant.
 *
 *  M23: AND IT IS NO LONGER `HEAD_H`. The address strip sits above the column band, so the viewport
 *  starts below BOTH — and `rowTop` reads this and not `HEAD_H`, which is the distinction that cost
 *  fourteen of `www/m18.html`'s clauses while the two were conflated. */
const VIEW_TOP = CRUMB_H + HEAD_H;

/**
 * THE MIDDLE OF THE COLUMN-HEADER BAND, CSS px — what a driver that wants to press "the header"
 * should aim at, and the reason it exists is in `CRUMB_H`'s docstring: `VIEW_TOP / 2` was that
 * point when the header was the only thing above the viewport, and it is now a point whose band
 * depends on an inequality between two constants. This names the band instead.
 */
const HEADER_MID = HEAD_H / 2;

/** THE MIDDLE OF THE ADDRESS STRIP, CSS px — the other half of the same argument, so a driver
 *  aiming at a breadcrumb segment or the search field does not derive a y of its own. */
const CRUMB_MID = CRUMB_TOP + CRUMB_H / 2;

/**
 * THE BREADCRUMB'S SEGMENTS for `path`, inside an address strip `wCss` wide — `{ label, path, x, w }`
 * per segment, in order, left to right, with the ROOT first.
 *
 * ONE DEFINITION, READ BY THE DRAWING AND BY THE HIT TEST, which is `rowTop`'s rule again and here
 * it is what makes "clicking a segment goes there" true rather than approximately true: the
 * rectangle a press is tested against is the rectangle the label was bounded by, so a short name in
 * a wide box still lands on its own segment.
 *
 * THE WIDTH IS `MONO_ADVANCE_PER_PX` AND NOT A MEASUREMENT OF THE DRAWN GLYPHS. A program cannot
 * measure a string; what it can do is bound one, and a box that bounds its own run can be wider
 * than the glyphs but never narrower. See `MONO_ADVANCE_PER_PX` for why a mono width is the one
 * kind that does not move with the display's ratio.
 *
 * THE SEGMENTS ARE DROPPED FROM THE LEFT WHEN THEY DO NOT FIT, which is what Explorer does: the
 * directory a reader is IN is the one they most need to see, and a trail cut at the right end would
 * hide it. The first surviving segment is marked `elided` so the drawing can say so.
 */
const crumbSegments = (path, wCss) => {
  const trimmed = dirKey(path);
  const parts = trimmed === "" ? [] : trimmed.split("/").filter((p) => p !== "");
  const boxes = [];
  let at = "";
  // THE ROOT IS A SEGMENT. `files /` is a directory a reader can be in, and a trail that began at
  // the first NAMED component would give them nothing to press to get back to it.
  const all = [{ label: "/", path: "/" }].concat(parts.map((p) => {
    at = `${at}/${p}`;
    return { label: p, path: at };
  }));
  let x = CRUMB_PAD;
  for (const seg of all) {
    const w = Math.ceil(seg.label.length * TEXT_PX * MONO_ADVANCE_PER_PX) + CRUMB_PAD * 2;
    boxes.push({ ...seg, x, w });
    x += w + CRUMB_PAD;
  }
  const room = Math.max(0, wCss - SEARCH_W - VIEWBTN_W - CRUMB_PAD);
  let drop = 0;
  while (drop < boxes.length - 1 && boxes[boxes.length - 1].x + boxes[boxes.length - 1].w
    - boxes[drop].x + CRUMB_PAD > room) drop += 1;
  const shift = boxes[drop] ? boxes[drop].x - CRUMB_PAD : 0;
  return boxes.slice(drop).map((b, n) => ({
    ...b, x: b.x - shift, elided: drop > 0 && n === 0,
  }));
};

/**
 * WHAT A CSS-PX POINT IN THE ADDRESS STRIP IS AIMED AT: `{ kind, index }`, where `kind` is
 * `"segment"`, `"search"`, `"view"` or `"empty"` and `index` is the segment's.
 *
 * `"empty"` IS A REAL ANSWER AND NOT A MISS, because R28's second half is that a click in the empty
 * strip turns the trail into an editable path. The order of the tests is the order the strip is
 * drawn in from the right, so a segment can never sit under the search field: the segments are laid
 * out inside `wCss - SEARCH_W - VIEWBTN_W` and the two controls own the remainder outright.
 */
const crumbHit = (xCss, path, wCss) => {
  if (xCss >= wCss - VIEWBTN_W) return { kind: "view", index: -1 };
  if (xCss >= wCss - VIEWBTN_W - SEARCH_W) return { kind: "search", index: -1 };
  const segs = crumbSegments(path, wCss);
  const at = segs.findIndex((s) => xCss >= s.x && xCss < s.x + s.w);
  return at < 0 ? { kind: "empty", index: -1 } : { kind: "segment", index: at };
};

/* ---- M23: SEARCH, AND EXACTLY WHAT IT LOOKS AT ------------------------------------------- */

/**
 * WHETHER `name` MATCHES `query` — a CASE-FOLDED SUBSTRING, and nothing cleverer.
 *
 * NOT A GLOB AND NOT A REGULAR EXPRESSION, and that is a decision rather than an omission: a reader
 * typing into a box expects every keystroke to narrow what they are looking at, and an incomplete
 * glob (`*.tx`) matches nothing while an incomplete substring matches more. A regular expression
 * built from a reader's typing is also a way to spend unbounded time on a 40-character directory
 * name, which is a cost nothing here could bound.
 *
 * `toLowerCase` AND NOT A LOCALE FOLD. `toLocaleLowerCase` answers differently per host locale,
 * which would make the same query match different files on two machines — and a filter nobody can
 * predict is a filter a check cannot assert.
 */
const searchMatch = (name, query) =>
  query === "" || String(name).toLowerCase().includes(query.toLowerCase());

/**
 * HOW DEEP A SEARCH WALK MAY GO, and HOW MANY ENTRIES IT MAY READ. Both are hard refusals with the
 * figure named, never a silent stop.
 *
 * 64 IS THE DEPTH `src/bin/rm.mjs` AND `src/bin/cp.mjs` ALREADY USE, each with its own copy of the
 * number (PRD R31 records both). This is a THIRD copy and it should not be: the PRD's answer is a
 * shared bounded walk in `src/libos/std.mjs`, which is not this slice's file — reported rather than
 * made.
 *
 * THE ENTRY CEILING IS WHAT MAKES THE WALK FINITE IN PRACTICE. Depth alone bounds nothing useful: a
 * tree 3 deep and 10,000 wide is inside every depth limit and is 10,000 `readdir` entries plus one
 * `lstat` per MATCH. 20,000 at roughly 85 µs per directory component (constraint 24) is the figure
 * the strip reports; a reader who hits it is told, with the count.
 */
const SEARCH_MAX_DEPTH = 64;
const SEARCH_MAX_ENTRIES = 20000;
/**
 * How many entries one chunk of the walk reads before it returns to the event loop. R31 requires
 * the walk be chunked "so the window keeps servicing input", and this is the grain.
 *
 * THE GRAIN IS A DIRECTORY AND NOT AN ENTRY, which this number states rather than enforces: the
 * budget is checked between directories, so a chunk reads AT LEAST one whole directory and stops
 * once it has seen this many entries. A single directory of ten thousand entries is therefore one
 * chunk. The alternative — stopping mid-directory — needs a resume point inside a `readdir`, and
 * `std.listDir` returns a whole listing; a walker that re-read the directory to resume would pay
 * for it twice and could see it change between the two reads.
 */
const SEARCH_CHUNK = 256;

/** The y of a row's top, CSS px, measured inside the client area and MINUS THE SCROLL OFFSET.
 *  `scroll` defaults to 0, which is the unscrolled layout every caller before M17 asked for. */
/* M23: `VIEW_TOP` AND NOT `HEAD_H`, AND THE TWO WERE THE SAME NUMBER UNTIL THE ADDRESS STRIP
 * ARRIVED. `VIEW_TOP` is the top of the clipped viewport and the first row sits `PAD` below it;
 * `HEAD_H` is only the COLUMN BAND'S height. Leaving `HEAD_H` here put the rows 22 CSS px above the
 * viewport that bounds them, so `inViewport` rejected a press aimed at `rowMid` and a driven
 * double-click reached no row at all — measured as `dblclicks: 0` and `relists: 0` across fourteen
 * of `www/m18.html`'s clauses. */
const rowTop = (i, scroll = 0) => VIEW_TOP + PAD + i * ROW_STRIDE - scroll;
/** The middle of a row, CSS px: where a driver outside the process aims. */
const rowMid = (i, scroll = 0) => rowTop(i, scroll) + ROW_H / 2;

/**
 * The row index a CSS-px `y` falls in at scroll offset `scroll`, or `-1` for the header, a gap
 * between two rows, or anything above the list. THE DECLARED INVERSE OF `rowTop`, which is what
 * makes a press land on the row a reader sees — `src/wm/desktop.mjs` states the same rule for its
 * icon grid.
 *
 * IT IS NOT BOUNDED BY THE ROW COUNT OR BY THE VIEWPORT, because both are live and this object is
 * frozen. The caller bounds it; see `rowUnder` in `run`.
 */
const rowAt = (yCss, scroll = 0) => {
  const i = Math.floor((yCss - rowTop(0, scroll)) / ROW_STRIDE);
  if (i < 0) return -1;
  // The gap between two rows belongs to neither, so a press there selects nothing rather than
  // the row above it by rounding.
  return yCss - rowTop(i, scroll) < ROW_H ? i : -1;
};

/** How far inside a row the keyboard cursor's ring sits, CSS px. One pixel, so a row that is both
 *  selected and focused shows the selection's outline AND this one rather than one over the other.
 *  `focusBox` is the only reader. */
const FOCUS_INSET = 1;

/** THE KEYBOARD CURSOR'S RING as a rectangle, CSS px — the ONE definition of where it is drawn.
 *  `paint` strokes it and anything outside the process that wants to read its pixels asks here, for
 *  `rowTop`'s reason: a second copy of an inset is a check sampling one pixel off the ring. */
const focusBox = (i, scroll = 0, wCss = 0) => ({
  x: PAD + FOCUS_INSET,
  y: rowTop(i, scroll) + FOCUS_INSET,
  w: Math.max(0, wCss - PAD * 2 - FOCUS_INSET * 2),
  h: ROW_H - FOCUS_INSET * 2,
});

/**
 * THE CLIPPED VIEWPORT, CSS px, inside a client area `wCss` x `hCss`. One rectangle, read in three
 * places — the `DL_CLIP` op, the hit test's bound, and whatever outside the process wants to aim
 * inside it — so a driver cannot pick a point the program would clip away.
 *
 * ITS BOTTOM KEEPS `PAD`, which is what makes the bottom edge a VIEWPORT edge rather than the
 * canvas's: a row cut there was cut by this rectangle, and a check reading the pixels can tell the
 * two apart. `scrollMax` is derived from the same `PAD`, so the last row's bottom lands exactly on
 * it at full scroll.
 *
 * M19: AND `FOOT_H` BELOW THAT, because the status strip is part of the client area and not part of
 * the list. Every one of the four functions below carries the same term, which is what keeps
 * `rowsThatFit` and `clientHeightFor` declared inverses and `scrollMax(n, clientHeightFor(n))` zero.
 */
const viewBox = (wCss, hCss) => ({
  x: 0, y: VIEW_TOP, w: Math.max(0, wCss), h: Math.max(0, hCss - VIEW_TOP - PAD - FOOT_H),
});

/** The largest legal scroll offset for `n` rows in a client area `hCss` tall, CSS px: the offset at
 *  which the last row's bottom sits on the viewport's. ZERO when everything fits, which is the top
 *  clamp and the bottom clamp being the same number — a window taller than its content cannot
 *  scroll at all. The DECLARED PARTNER of `rowTop`: `rowTop(n - 1, scrollMax(n, h)) + ROW_H` is the
 *  viewport's bottom. */
const scrollMax = (n, hCss) =>
  Math.max(0, (n > 0 ? rowTop(n - 1) + ROW_H : 0) + PAD + FOOT_H - hCss);

/** How many rows a client area `hCss` CSS px tall shows at once — `viewBox`'s height less the pad
 *  above the first row, in whole pitches. At least one: a window clamped to its minimum still owes
 *  a reader a row rather than a header over nothing. `clientHeightFor` is the declared inverse. */
const rowsThatFit = (hCss) =>
  Math.max(1, Math.floor((hCss - VIEW_TOP - PAD * 2 - FOOT_H + ROW_GAP) / ROW_STRIDE));

/** The client height `n` rows need, CSS px. Only the OPENING size reads it — after that the height
 *  is the reader's and the row count follows it — but it is `rowsThatFit`'s declared inverse, so
 *  `scrollMax(n, clientHeightFor(n))` is 0 and a window opened to fit its content cannot scroll. */
const clientHeightFor = (n) => VIEW_TOP + PAD * 2 + FOOT_H + n * ROW_STRIDE - ROW_GAP;

/**
 * A RUBBER BAND AS A RECTANGLE, CSS px, from the two corners it was dragged between. The corners
 * are in CONTENT coordinates — `y` measured down the whole list rather than down the window —
 * which is what lets a band keep hold of the rows it was drawn over while the list scrolls.
 *
 * NORMALISED, because a band is dragged in all four directions and a negative width is a rectangle
 * nothing intersects. ONE definition, read by the drawing, by the hit test and by a driver outside
 * the process, so a reader cannot see a band over a row it did not select.
 */
const bandBox = (band) => ({
  x: Math.min(band.x0, band.x1),
  y: Math.min(band.y0, band.y1),
  w: Math.abs(band.x1 - band.x0),
  h: Math.abs(band.y1 - band.y0),
});

/**
 * THE ROWS A BAND TOUCHES, BY INTERSECTION — not by containment, which is the rule every file
 * manager uses: a band drawn across the middle of a list selects the rows it crosses rather than
 * only the ones it swallowed whole.
 *
 * A ROW'S RECTANGLE IS THE ONE `paint` FILLS, in content coordinates: `rowTop(i)` with no offset,
 * `PAD` to `wCss - PAD` across. A zero-width or zero-height band touches nothing, which is a press
 * that never moved — and is why a click on empty space clears the selection rather than selecting
 * whatever row the degenerate rectangle happens to graze.
 *
 * PURE, AND EXPORTED FOR `rowTop`'S REASON: a driver that wanted to assert which rows a band took
 * would otherwise restate the intersection, and an off-by-one in a restated edge is a check that
 * passes for the wrong set.
 */
const bandRows = (band, n, wCss) => {
  const r = bandBox(band);
  const hit = new Set();
  if (r.w <= 0 || r.h <= 0) return hit;
  const left = PAD;
  const right = Math.max(left, wCss - PAD);
  if (r.x >= right || r.x + r.w <= left) return hit;
  for (let i = 0; i < n; i += 1) {
    const top = rowTop(i);
    if (r.y < top + ROW_H && r.y + r.h > top) hit.add(i);
  }
  return hit;
};

/** A CSS-px length as a surface coordinate, rounded: `encodeDrawOp` truncates (`a0: op.a0 | 0`),
 *  and a truncated edge is a half-pixel seam at a fractional ratio. */
const toSurface = (vCss, scale) => Math.round(vCss * scale);

/* ---- M23: THE SEVEN VIEW MODES, AS DATA -------------------------------------------------- */

/**
 * THREE FLOWS AND NOT SEVEN LAYOUTS. Windows 7 ships seven view modes on a continuum, and the thing
 * that actually differs between them is the CELL and which way the overflow runs:
 *
 *   `rows`    one item per line, the full width of the viewport: Details, and only Details, because
 *             it is the only mode with columns. Its arithmetic is `rowTop`/`rowAt`, unchanged and
 *             still exported — every generalised function below DELEGATES to them in this flow
 *             rather than restating the formula, so the Details layout has one definition and the
 *             three proof pages that aim at it need no change.
 *   `grid`     cells left to right, wrapping down, scrolling DOWN: the four icon sizes and Tiles.
 *   `columns`  cells top to bottom, wrapping ACROSS, scrolling ACROSS: List, and nothing else.
 *              That is the whole distinction between List and Small icons (PRD R27) — the same
 *              cell, the other flow — and it is why `scroll` is an offset along the MODE'S OWN
 *              AXIS and not a `y`.
 */
const FLOW_ROWS = "rows";
const FLOW_GRID = "grid";
const FLOW_COLUMNS = "columns";

const VIEW_XLARGE = "xlarge";
const VIEW_LARGE = "large";
const VIEW_MEDIUM = "medium";
const VIEW_SMALL = "small";
const VIEW_LIST = "list";
const VIEW_DETAILS = "details";
const VIEW_TILES = "tiles";

/** The gutter between two cells, CSS px. Both axes, so a grid's spacing does not depend on which
 *  way it flows. `ROW_GAP` is the `rows` flow's own and stays what it was. */
const CELL_GAP = 6;
/** One line of label under or beside an icon, CSS px — `TEXT_PX` plus the leading a 12 px run needs
 *  to sit clear of the line below it. */
const LABEL_H = 16;

/**
 * THE SEVEN MODES. One row each: what it is called, how it flows, how big its icon is, how wide its
 * cell is, whether a picture is drawn in it, how many label lines it has, and whether the label sits
 * BELOW the icon or beside it.
 *
 * THE ORDER IS THE SLIDER'S, largest first, which is Windows' own order in the View menu and the
 * direction Ctrl+wheel steps: a wheel AWAY from the reader makes the icons bigger. Adding a mode is
 * adding a row here and nothing else (CLAUDE.md: adding the next case should be adding data).
 *
 * `thumbs` IS R26'S SCOPE AND NOT A PREFERENCE. The PRD says "thumbnails at Medium icons and
 * larger", which is Windows' own rule: Details, Small icons and List show the TYPE ICON, because a
 * 16 CSS px picture of a photograph is less informative than the icon that says what it is. It is
 * also what keeps a `files` window in the default mode holding no data object at all, which matters
 * beyond the look — see `fillThumbs`.
 *
 * `cellW` IS DECLARED AND `cellH` IS DERIVED (`cellHOf`), because the height is a function of the
 * icon and the label lines while the width is a judgement about how much room a name needs.
 */
const VIEWS = Object.freeze([
  Object.freeze({ id: VIEW_XLARGE, label: "Extra large icons", flow: FLOW_GRID,
    icon: 256, cellW: 268, thumbs: true, lines: 2, below: true }),
  Object.freeze({ id: VIEW_LARGE, label: "Large icons", flow: FLOW_GRID,
    icon: 96, cellW: 120, thumbs: true, lines: 2, below: true }),
  Object.freeze({ id: VIEW_MEDIUM, label: "Medium icons", flow: FLOW_GRID,
    icon: 48, cellW: 92, thumbs: true, lines: 2, below: true }),
  Object.freeze({ id: VIEW_SMALL, label: "Small icons", flow: FLOW_GRID,
    icon: GLYPH_W, cellW: 172, thumbs: false, lines: 1, below: false }),
  Object.freeze({ id: VIEW_LIST, label: "List", flow: FLOW_COLUMNS,
    icon: GLYPH_W, cellW: 172, thumbs: false, lines: 1, below: false }),
  Object.freeze({ id: VIEW_DETAILS, label: "Details", flow: FLOW_ROWS,
    icon: GLYPH_W, cellW: 0, thumbs: false, lines: 1, below: false }),
  Object.freeze({ id: VIEW_TILES, label: "Tiles", flow: FLOW_GRID,
    icon: 48, cellW: 212, thumbs: true, lines: 2, below: false }),
]);

/**
 * id -> row. A mode named by argv or by a remembered folder is looked up here and an unknown one
 * is refused by name rather than silently defaulted.
 *
 * `Object.create(null)` AND NOT `Object.fromEntries`, which is a fix and not a style. A plain
 * object inherits `Object.prototype`, so `VIEW_BY_ID["toString"]` is a FUNCTION — truthy — and
 * `--view toString` passed the usage guard, became `view`, and gave `cellHOf` a row with no `flow`
 * and no `icon`: a NaN geometry and a window that draws nothing, from an argument the guard was
 * written to refuse by name. A prototype-less map has no key but the seven.
 */
const VIEW_BY_ID = Object.freeze(Object.assign(Object.create(null),
  Object.fromEntries(VIEWS.map((v) => [v.id, v]))));

/** THE MODE A WINDOW OPENS IN, and it is Details for the reason every file manager opens in it: it
 *  is the only mode that shows a date, a type and a size, which is what a reader opening a folder
 *  they do not know is looking for (PRD R7). */
const VIEW_DEFAULT = VIEW_DETAILS;

/**
 * ONE CELL'S HEIGHT, CSS px, DERIVED from the icon and the label.
 *
 * `below` STACKS AND BESIDE DOES NOT: a label under an icon adds its lines to the icon's height,
 * while a label beside one shares it — so a Tiles cell is as tall as the taller of its two halves
 * and a Large icons cell is the sum. The `rows` flow has no cell of its own: `ROW_H` is its height
 * and `ROW_STRIDE` its pitch, which is the one geometry the Details view has always had.
 */
const cellHOf = (view) => (view.flow === FLOW_ROWS ? ROW_H
  : (view.below ? view.icon + view.lines * LABEL_H
    // `ROW_H` IS THE FLOOR FOR A LABEL BESIDE AN ICON, because a one-line cell with a name in it IS
    // a row — a 16 px cell holding a 12 px run leaves two pixels above and below, which reads as
    // text jammed against its neighbours. Small icons and List are that cell, and `ROW_H` is the
    // height the Details view already gives one line of a name.
    : Math.max(ROW_H, view.icon, view.lines * LABEL_H)));

/**
 * HOW MANY CELLS FIT ALONG THE FIXED AXIS, and the pitch on both — for `view` in a viewport `box`.
 *
 * `lanes` IS COLUMNS FOR A GRID AND ROWS FOR THE LIST, which is what makes one function answer for
 * both flows: a lane is the run of cells that fills before the layout wraps. At least one, because
 * a window narrower than one cell still owes a reader that cell rather than nothing — the canvas
 * cuts it, which is what Explorer does.
 *
 * THE `rows` FLOW HAS ONE LANE AND ITS PITCH IS `ROW_STRIDE`. Everything below it then falls out of
 * the same arithmetic the Details view already used, which is why `itemBox` and `itemAtPoint` can
 * delegate to `rowTop` and `rowAt` instead of agreeing with them.
 */
const lanesOf = (view, box) => {
  if (view.flow === FLOW_ROWS) {
    return { lanes: 1, pitchW: Math.max(0, box.w - PAD * 2), pitchH: ROW_STRIDE };
  }
  const pitchW = view.cellW + CELL_GAP;
  const pitchH = cellHOf(view) + CELL_GAP;
  const along = view.flow === FLOW_COLUMNS ? box.h : box.w;
  const pitch = view.flow === FLOW_COLUMNS ? pitchH : pitchW;
  // `+ CELL_GAP` BECAUSE THE LAST CELL IN A LANE NEEDS NO GUTTER AFTER IT: without it a viewport
  // exactly wide enough for three cells fits two, and a reader sees a column of empty paper.
  return { lanes: Math.max(1, Math.floor((along - PAD * 2 + CELL_GAP) / pitch)), pitchW, pitchH };
};

/** WHICH WAY A MODE SCROLLS: `"x"` for the List and `"y"` for everything else. The one place that
 *  is decided, because `scroll` is an offset along this axis and a second opinion about which axis
 *  it is would scroll the content one way and hit-test it the other. */
const axisOf = (view) => (view.flow === FLOW_COLUMNS ? "x" : "y");

/**
 * WHERE ITEM `i` SITS, CSS px, with `scroll` taken off the mode's own axis — the ONE definition,
 * read by the drawing, by the hit test, by the band and by anything outside the process.
 *
 * THE `rows` FLOW IS `rowTop` AND NOT A COPY OF IT. That is the whole reason this function has a
 * branch rather than a formula: the Details layout is exported, three proof pages aim at it, and a
 * second spelling of `VIEW_TOP + PAD + i * ROW_STRIDE` is how the two come to disagree by a pixel.
 */
const itemBox = (view, i, scroll, wCss, hCss) => {
  if (view.flow === FLOW_ROWS) {
    return { x: PAD, y: rowTop(i, scroll), w: Math.max(0, wCss - PAD * 2), h: ROW_H };
  }
  const box = viewBox(wCss, hCss);
  const { lanes, pitchW, pitchH } = lanesOf(view, box);
  const lane = i % lanes;
  const run = Math.floor(i / lanes);
  const across = view.flow === FLOW_COLUMNS ? run : lane;
  const down = view.flow === FLOW_COLUMNS ? lane : run;
  const dx = view.flow === FLOW_COLUMNS ? scroll : 0;
  const dy = view.flow === FLOW_COLUMNS ? 0 : scroll;
  return {
    x: PAD + across * pitchW - dx,
    y: box.y + PAD + down * pitchH - dy,
    w: view.cellW,
    h: cellHOf(view),
  };
};

/**
 * THE ITEM UNDER A CSS-PX POINT, or `-1` — THE DECLARED INVERSE OF `itemBox`, which is what makes a
 * press land on the cell a reader is looking at.
 *
 * UNBOUNDED BY THE ITEM COUNT, like `rowAt`, because the count is live and this is a pure function;
 * the caller bounds it (`rowUnder` in `run`). THE GUTTER BELONGS TO NEITHER CELL, for `rowAt`'s own
 * reason: a press in the gap selects nothing rather than a neighbour by rounding.
 */
const itemAtPoint = (view, xCss, yCss, scroll, wCss, hCss) => {
  if (view.flow === FLOW_ROWS) return rowAt(yCss, scroll);
  const box = viewBox(wCss, hCss);
  const { lanes, pitchW, pitchH } = lanesOf(view, box);
  const dx = view.flow === FLOW_COLUMNS ? scroll : 0;
  const dy = view.flow === FLOW_COLUMNS ? 0 : scroll;
  const ax = xCss + dx - PAD;
  const ay = yCss + dy - (box.y + PAD);
  if (ax < 0 || ay < 0) return -1;
  const across = Math.floor(ax / pitchW);
  const down = Math.floor(ay / pitchH);
  if (ax - across * pitchW >= view.cellW) return -1;
  if (ay - down * pitchH >= cellHOf(view)) return -1;
  const lane = view.flow === FLOW_COLUMNS ? down : across;
  const run = view.flow === FLOW_COLUMNS ? across : down;
  if (lane >= lanes) return -1;
  return run * lanes + lane;
};

/**
 * HOW FAR THE CONTENT RUNS ALONG THE SCROLL AXIS, CSS px, measured from the viewport's own edge.
 *
 * `PAD` AT THE NEAR END AND NONE AT THE FAR ONE, because the last cell's gutter is not content —
 * which is what makes `scrollMaxFor` put the last cell's edge exactly on the viewport's, the same
 * promise `scrollMax` already makes for a row.
 */
const contentLength = (view, n, wCss, hCss) => {
  const box = viewBox(wCss, hCss);
  const { lanes, pitchW, pitchH } = lanesOf(view, box);
  const runs = n > 0 ? Math.ceil(n / lanes) : 0;
  const pitch = axisOf(view) === "x" ? pitchW : pitchH;
  const cell = axisOf(view) === "x" ? view.cellW : cellHOf(view);
  return runs > 0 ? PAD + (runs - 1) * pitch + cell : 0;
};

/** THE LARGEST LEGAL OFFSET for `view`, CSS px. `scrollMax` IS CALLED for the `rows` flow rather
 *  than reproduced, so the Details clamp a check asserts against the export is the clamp the
 *  program applies. Zero when everything fits, which is both clamps being the same number. */
const scrollMaxFor = (view, n, wCss, hCss) => {
  if (view.flow === FLOW_ROWS) return scrollMax(n, hCss);
  const box = viewBox(wCss, hCss);
  const room = axisOf(view) === "x" ? box.w : box.h;
  /* `contentLength - room` AND NOTHING ADDED, which is `scrollMax`'s own arithmetic rewritten in
   * the viewport's terms: `scrollMax(n, hCss)` expands to exactly this once `viewBox`'s `- PAD -
   * FOOT_H` is substituted, which is how the two flows are known to clamp the same way rather than
   * hoped to. */
  return Math.max(0, contentLength(view, n, wCss, hCss) - room);
};

/** HOW MANY ITEMS A PAGE KEY MOVES: everything the viewport holds. `rowsThatFit` IS CALLED for the
 *  `rows` flow, for `scrollMaxFor`'s reason. At least one — a Page key that moved nothing would be
 *  a key a reader presses and watches do nothing. */
const pageStepFor = (view, n, wCss, hCss) => {
  if (view.flow === FLOW_ROWS) return rowsThatFit(hCss);
  const box = viewBox(wCss, hCss);
  const { lanes, pitchW, pitchH } = lanesOf(view, box);
  const room = axisOf(view) === "x" ? box.w : box.h;
  const pitch = axisOf(view) === "x" ? pitchW : pitchH;
  return Math.max(1, lanes * Math.max(1, Math.floor(room / pitch)));
};

/** HOW FAR ONE ARROW KEY MOVES ACROSS THE FLOW: one lane. In the `rows` flow there is one lane and
 *  Up/Down move by one item, which is what they have always done; in a grid they move by a whole
 *  row of cells, and Left/Right move by one. The List is the transpose of that. */
const laneStepFor = (view, wCss, hCss) =>
  (view.flow === FLOW_ROWS ? 1 : lanesOf(view, viewBox(wCss, hCss)).lanes);

/**
 * THE KEYBOARD CURSOR'S RING for `view`, CSS px. `focusBox` IS CALLED for the `rows` flow, so the
 * ring three proof pages read out of the export is the ring this program strokes; a cell's ring is
 * its own box inset by the same one pixel, for the same reason — a row that is both selected and
 * focused shows both marks.
 */
const focusBoxFor = (view, i, scroll, wCss, hCss) => {
  if (view.flow === FLOW_ROWS) return focusBox(i, scroll, wCss);
  const cell = itemBox(view, i, scroll, wCss, hCss);
  return {
    x: cell.x + FOCUS_INSET,
    y: cell.y + FOCUS_INSET,
    w: Math.max(0, cell.w - FOCUS_INSET * 2),
    h: Math.max(0, cell.h - FOCUS_INSET * 2),
  };
};

/**
 * THE ITEMS A BAND TOUCHES in `view`, by intersection. `bandRows` IS CALLED for the `rows` flow.
 *
 * THE BAND'S CORNERS ARE CONTENT COORDINATES ON THE SCROLL AXIS and window coordinates on the
 * other, which is what lets a band keep hold of what it was drawn over while the list scrolls — so
 * the comparison is made against each cell AT OFFSET ZERO, which is what `itemBox(view, i, 0, …)`
 * is. A band compared against the scrolled boxes would select whatever slid under it.
 */
const bandItems = (view, band, n, wCss, hCss) => {
  if (view.flow === FLOW_ROWS) return bandRows(band, n, wCss);
  const r = bandBox(band);
  const hit = new Set();
  if (r.w <= 0 || r.h <= 0) return hit;
  for (let i = 0; i < n; i += 1) {
    const cell = itemBox(view, i, 0, wCss, hCss);
    if (r.x < cell.x + cell.w && r.x + r.w > cell.x
      && r.y < cell.y + cell.h && r.y + r.h > cell.y) hit.add(i);
  }
  return hit;
};

/**
 * WHAT A ROW IS: `DIR`, a format name, `PROG`, or a dash — in that order of specificity, and in
 * ONE place because three things print it. The drawn type column, the `account.rows` a check reads
 * and the stdout legend all said it separately, and the format is what decides whether a row can
 * be DRAGGED — so a reader who was shown one word and refused for another would have no way to
 * tell which of the three was lying (constraint 294).
 *
 * The execute bit is the fallback and not a guess at a format: `/usr/bin` is 32 files no extension
 * rule covers, and a column that read `fmt?0` thirty-two times carried no information at all.
 */
/** WHAT A CELL SAYS WHEN THE SYSTEM KNOWS NOTHING, and it is a MARK rather than a blank for a
 *  reason M19 measured: `/usr` is a provider mount whose files publish no modification time, so a
 *  Date column over `/usr/bin` — which is what the desktop's own `files` window opens on — was
 *  twenty-five empty cells. An empty cell reads as a column that is broken; this reads as a column
 *  saying it does not know. `kindOf` already used the same mark for a type nothing names.
 *
 *  AN EMPTY CELL STILL MEANS SOMETHING, which is why both spellings exist: no call was PAID. A
 *  directory's Size is empty because its `st_size` is not the question, and every cell of a row
 *  under `--no-dir-stat` is empty because nothing was asked. */
const UNKNOWN_CELL = "—";

const kindOf = (row) => (row.dir ? "DIR"
  : row.format ? fmtName(row.format)
    : row.exec ? "PROG" : UNKNOWN_CELL);

/* ---- M19: THE FOUR COLUMNS, AS DATA ------------------------------------------------------- */

/** The three fixed column widths, CSS px, each sized to the widest cell it has to hold: a
 *  16-character timestamp, `BITMAP`, and a six-digit kilobyte count. They are written here rather
 *  than fitted to content for the reason in this file's header — a fitted width would move with the
 *  display's ratio. */
const DATE_W = 120;
const TYPE_W = 60;
const SIZE_W = 64;
/** The narrowest the flexible Name column may become. Below it the fixed columns run off the right
 *  edge and the canvas cuts them, which is what Explorer does and is better than a name column too
 *  narrow to hold a character. */
const NAME_MIN_W = 48;

/**
 * THE DETAILS VIEW'S COLUMNS. One row per column: the key a sort and a cell are named by, the
 * header's label, and the fixed width — `0` meaning "take whatever is left". Adding a column is
 * adding a row here.
 *
 * EVERY COLUMN BUT THE NAME IS RIGHT-ALIGNED, and that is structural as well as a look. A
 * metadata column is read down its own edge; and the NAME is then the only LEFT-aligned run after
 * the `DL_CLIP`, which is how a driver outside the process names the rows with no coordinate and no
 * scale in the test (`www/m18.html`'s `rowRuns`). A second left-aligned cell would make every date
 * read as a row name.
 *
 * `mono` IS NOT DECORATION EITHER: a monospaced column of dates and sizes lines its digits up, and
 * a monospaced run is the one kind whose width a published advance table prices EXACTLY
 * (`advanceWidth` in src/abi.mjs, measured over 2,448 samples).
 */
const COLUMNS = Object.freeze([
  Object.freeze({ key: "name", label: "Name", w: 0, mono: false }),
  Object.freeze({ key: "date", label: "Date modified", w: DATE_W, mono: true }),
  Object.freeze({ key: "type", label: "Type", w: TYPE_W, mono: true }),
  Object.freeze({ key: "size", label: "Size", w: SIZE_W, mono: true }),
]);

/** The column the sort opens on, and the direction. ASCENDING, which is also the order `buildRows`
 *  produces, so the opening list and the opening sort state agree. */
const SORT_DEFAULT = Object.freeze({ key: "name", dir: 1 });

/**
 * WHERE EVERY COLUMN IS, CSS px, inside a client area `wCss` wide — the ONE definition, read by
 * the header's labels, by every cell, by the sort's hit test and by anything outside the process
 * that wants to aim at a column.
 *
 * `x`/`right` BOUND THE COLUMN AND `textX` IS WHERE ITS RUN IS DRAWN, and the two differ in both
 * directions: the Name column's box starts at `PAD` because the glyph belongs to it while its text
 * starts at `NAME_X`, and a right-aligned column's text sits AT its right edge, which is what
 * `DLT_RIGHT` means.
 */
const columnBoxes = (wCss) => {
  const edge = Math.max(0, wCss - PAD - TYPE_INSET);
  const fixed = COLUMNS.reduce((n, c) => n + c.w, 0);
  const flexible = Math.max(NAME_MIN_W, edge - PAD - fixed);
  let x = PAD;
  return COLUMNS.map((c) => {
    const w = c.w || flexible;
    const box = {
      key: c.key, label: c.label, mono: c.mono, x, w, right: x + w,
      textX: c.key === "name" ? NAME_X : x + w,
      right_aligned: c.key !== "name",
    };
    x += w;
    return box;
  });
};

/** The key of the column a CSS-px `x` falls in, or `null` past the last one. THE DECLARED INVERSE
 *  OF `columnBoxes`, which is what makes a header press sort the column a reader is pointing at. */
const columnAt = (xCss, wCss) => {
  const hit = columnBoxes(wCss).find((c) => xCss >= c.x && xCss < c.right);
  return hit ? hit.key : null;
};

/**
 * A MODIFICATION TIME AS A CELL, or `""` for a stamp of zero. `cellOf` is what turns that into the
 * UNKNOWN mark for a row that WAS statted, so this stays a pure format of a number.
 *
 * `YYYY-MM-DD HH:MM` IN LOCAL TIME, AND THE FORMAT IS DELIBERATELY NOT THE HOST'S. A locale
 * rendering is whatever the browser's `toLocaleString` decides, which no driver outside the process
 * can predict and no check can assert; this one is 16 characters wide whatever the date, which is
 * also what lets `DATE_W` be a constant. The sort reads the NUMBER and never this string, so the
 * ordering does not depend on the spelling.
 */
const dateText = (mtimeMs) => {
  if (!(mtimeMs > 0)) return "";
  const d = new Date(mtimeMs);
  const p = (v, n = 2) => String(v).padStart(n, "0");
  return `${p(d.getFullYear(), 4)}-${p(d.getMonth() + 1)}-${p(d.getDate())} `
    + `${p(d.getHours())}:${p(d.getMinutes())}`;
};

/**
 * A SIZE AS A CELL — kilobytes, rounded UP, which is Explorer's own Size column.
 *
 * A DIRECTORY'S CELL IS EMPTY, and that is a statement rather than a gap: `st_size` on a directory
 * is the size of its entry table, which is not the question "how big is this folder" that a reader
 * asked. The DATE beside it is drawn, and the pair is what says the stat was paid.
 *
 * ROUNDED UP SO NO NON-EMPTY FILE READS AS `0 KB`: a one-byte file occupies a block, and `0 KB`
 * beside a name is the spelling of "empty". An empty file is `0 KB` and is the only thing that is.
 */
const sizeText = (row) => {
  if (row.dir || !row.statted) return "";
  const bytes = Number(row.size) || 0;
  return `${bytes > 0 ? Math.max(1, Math.ceil(bytes / 1024)) : 0} KB`;
};

/**
 * ONE CELL'S TEXT, and the ONE place a column's key becomes a string. `paint` draws what this
 * returns and `account.rows` reports it, so what a check reads is what a reader saw.
 *
 * THE DATE IS WHERE "NOT ASKED" AND "ASKED AND UNKNOWN" PART. A row whose `lstat` was never paid
 * has an empty cell; a row that was statted and came back with a zero stamp gets the UNKNOWN mark.
 * Collapsing the two would make `--no-dir-stat` turn nothing on a provider mount, and a control
 * that turns nothing verifies nothing.
 */
const cellOf = (row, key) => {
  if (key === "name") return row.name;
  if (key === "type") return kindOf(row);
  if (key === "date") return row.statted ? (dateText(row.mtimeMs) || UNKNOWN_CELL) : "";
  if (key === "size") return sizeText(row);
  return "";
};

/** WHAT A COLUMN SORTS ON, which is a number for two of them and a string for two. Never the cell
 *  text: a date sorted by its spelling is a date sorted lexicographically, and a size sorted by
 *  `"9 KB"` against `"10 KB"` puts the larger first. A DIRECTORY'S SIZE IS `-1` — below every file,
 *  including an empty one — because its cell is empty and an empty cell has no magnitude. */
const sortValue = (row, key) => {
  if (key === "date") return Number(row.mtimeMs) || 0;
  if (key === "size") return row.dir ? -1 : (Number(row.size) || 0);
  if (key === "type") return kindOf(row);
  return row.name;
};

/** Two sort values of the same kind. `<` orders numbers numerically and strings by code unit, which
 *  is the one comparison both kinds share — `sortValue` is what guarantees they are never mixed. */
const compareValues = (a, b) => (a === b ? 0 : (a < b ? -1 : 1));

/**
 * THE ORDER, AS ONE COMPARATOR — three terms, applied in this sequence and no other.
 *
 * 1. DIRECTORIES FIRST, and NOT multiplied by the direction: "folders before files" is not a
 *    reading of a column, so reversing the sort must not turn it over. `--folders-last` is the
 *    world where it is the other way, and nothing else moves.
 * 2. THE CHOSEN COLUMN, times the direction.
 * 3. THE NAME, ASCENDING WHICHEVER WAY THE PRIMARY SORTED. This is the stable term, and the
 *    sentence above is the whole of it: the order inside a group of equal dates or equal types is
 *    the same whether the dates ascend or descend, so a reader who reverses a sort does not find
 *    the rows inside each group shuffled as well. `--stable-sort-off` multiplies this term by the
 *    direction too — `dir * (byKey || byName)`, the naive spelling — and that is the only clause it
 *    moves.
 *
 * WHEN THE PRIMARY IS THE NAME there is no third term to apply, so the direction reaches the names
 * directly and a descending name sort descends.
 */
const compareRows = (a, b, { key, dir }, { foldersLast = false, stableSortOff = false } = {}) => {
  if (a.dir !== b.dir) return (a.dir ? -1 : 1) * (foldersLast ? -1 : 1);
  const primary = compareValues(sortValue(a, key), sortValue(b, key));
  if (key === "name" || primary !== 0) return primary * dir;
  const byName = compareValues(a.name, b.name);
  return stableSortOff ? byName * dir : byName;
};

/* ---- M20: THE SIX VERBS, THE TWO MENUS AND WHAT A NAME MAY BE ----------------------------- */

/**
 * THE VERBS, AS NAMES. A menu row carries one of these and `WEV_ITEM` reports an INDEX into the
 * rows this program published — so the index becomes a verb HERE and the page never learns what a
 * row does, which is `win_items`' division at a different moment (`src/bin/desktop.mjs`).
 *
 * STRINGS AND NOT SMALL INTEGERS, because they leave the process: `account.chosen` is what a check
 * reads to say which verb a driven click ran, and `2` in that array would need a table beside it.
 */
const V_OPEN = "open";
const V_NEW_FOLDER = "new-folder";
const V_RENAME = "rename";
const V_DELETE = "delete";
const V_CUT = "cut";
const V_COPY = "copy";
const V_PASTE = "paste";
/** M21. Put a row in the Bin back where its origin record says it came from. A verb of the BIN and
 *  nowhere else, so it is in no menu a reader meets outside it. */
const V_RESTORE = "restore";

/** A separator row. The label is ignored (`WITEM_SEPARATOR`) and `verb` is empty, so a report
 *  against one is refused by `runVerb` as well as by the kernel — two refusals over one fact, and
 *  the kernel's is the one that counts because the flags are enforced on its side. */
const MENU_RULE = Object.freeze({
  verb: "", icon: WICON_GENERIC, label: "", flags: WITEM_SEPARATOR,
});

/** What a newly created folder is called, and the stem `freeFrom` numbers from. Explorer's own
 *  wording, because a reader who has made one before knows what to look for. */
const NEW_FOLDER_STEM = "New folder";

/* ---- M21: THE BIN, AND THE TWO RECORDS A DELETE LEAVES ------------------------------------ */

/** THE RESERVED DIRECTORY A DELETE MOVES BYTES INTO, in the session tree. Windows 7's own name for
 *  it at a volume root, because a reader who has seen `$Recycle.Bin` knows what it is. IT IS NOT
 *  HIDDEN from a listing: a file manager that hides a directory is the defect M14 removed from the
 *  other end, and this is the directory "where did it go" is answered in. */
const BIN_NAME = "$Recycle.Bin";

/** THE ORIGIN RECORD'S NAME: the payload's own name plus this suffix. A SYMLINK, for the measured
 *  reason in this file's header — one CRC-covered journal record rather than an unchecksummed blob,
 *  and two records per delete rather than three. */
const ORIGIN_SUFFIX = ".origin";

/** A path with its trailing slashes gone, so `/a/b/` and `/a/b` are one directory and a comparison
 *  between two spellings of one place cannot answer no. The ROOT keeps its slash: `""` is not a
 *  path. Lexical and not `realpath`, which `env.fs` does not carry yet. */
const dirKey = (path) => {
  const trimmed = String(path).replace(/\/+$/, "");
  return trimmed === "" ? "/" : trimmed;
};

/** Whether `path` is `root` or something under it. THE SEPARATOR IS PART OF THE TEST: a plain
 *  `startsWith` makes `/Users/Defaults` a child of `/Users/Default`, which would send one reader's
 *  deletes into another's Bin. */
const underDir = (path, root) => {
  const p = dirKey(path);
  const r = dirKey(root);
  return p === r || p.startsWith(r === "/" ? "/" : `${r}/`);
};

/** WHERE THE BIN IS for a session tree rooted at `home` — one definition, exported, because a
 *  driver outside the process asserts the two records a delete left and must not restate the name
 *  of the directory they are in. */
const binDirIn = (home) => `${dirKey(home)}/${BIN_NAME}`;

/** THE ORIGIN RECORD BESIDE A PAYLOAD. `binDirIn`'s declared partner: the pair is what a check
 *  reads to say a delete left both records, and what a restore reads to say where one goes. */
const originRecordOf = (payloadPath) => `${payloadPath}${ORIGIN_SUFFIX}`;

/**
 * A NAME NOTHING IN `taken` HOLDS: `stem`, then `stem (2)` — Explorer's own numbering, and `null`
 * past a thousand.
 *
 * ONE DEFINITION, because New folder and the Bin's payload naming are the same question asked of
 * two directories. `reserve` is what makes the Bin's answer leave room for the ORIGIN RECORD beside
 * the payload: a payload called `x` needs `x.origin` free as well, or the next delete of a file
 * actually named `x.origin` would overwrite a record.
 */
const freeFrom = (taken, stem, reserve = null) => {
  const free = (c) => !taken.has(c) && (reserve === null || !taken.has(reserve(c)));
  if (free(stem)) return stem;
  for (let n = 2; n <= 1000; n += 1) {
    const candidate = `${stem} (${n})`;
    if (free(candidate)) return candidate;
  }
  return null;
};

/** `NAME_MAX` IS A BYTE COUNT (`src/abi.mjs`), so a length test has to encode. One encoder, built
 *  once: `nameFault` runs on every commit and `new TextEncoder()` per keystroke is an allocation
 *  per keystroke. `env.std.bytes` is the same encoder behind a function this module cannot reach
 *  from module scope, which is the only reason this is a second one. */
const NAME_ENC = new TextEncoder();

/**
 * WHY A NAME CANNOT BE USED, or `""`. The reasons are this program's and the filesystem's both: an
 * empty name and a name with a `/` in it are refused HERE because `rename` would otherwise be asked
 * to move a file to a path the reader did not type — `a/b` under a rename box is a MOVE, and a
 * rename field that silently moved a file into a subdirectory is the defect.
 *
 * `.` AND `..` ARE REFUSED BY NAME rather than left to the kernel's EEXIST/EINVAL, because what the
 * reader needs to be told is that those two are the directory itself and its parent.
 *
 * MEASURED IN BYTES AND NOT IN CHARACTERS: `NAME_MAX` is a byte count in `src/abi.mjs` and a
 * two-byte character would otherwise pass a length test and be refused by the kernel.
 */
const nameFault = (name) => {
  if (name === "") return "a name cannot be empty";
  if (name === "." || name === "..") return "that name is this directory or its parent";
  if (name.includes("/")) return "a name cannot contain a slash; this field renames, it does not move";
  if (name.includes("\0")) return "a name cannot contain a NUL";
  if (NAME_ENC.encode(name).length > NAME_MAX) return `a name is at most ${NAME_MAX} bytes`;
  return "";
};

/** The last component of a path — what a pasted file is called in its new directory. A trailing
 *  slash is dropped first, so pasting `/tmp/dir/` lands on `dir` and not on `""`. */
const baseNameOf = (path) => {
  const trimmed = String(path).replace(/\/+$/, "");
  const cut = trimmed.lastIndexOf("/");
  return cut < 0 ? trimmed : trimmed.slice(cut + 1);
};

/* ---- M23: THUMBNAILS, AND THE THREE CEILINGS THAT BOUND THEM ------------------------------ */

/**
 * WHICH FORMATS BECOME A PICTURE, as data — the only table in this program that says a file's bytes
 * can be drawn.
 *
 * TWO ENTRIES AND THEY ARRIVE BY DIFFERENT ROUTES. `DOBJ_PNG` goes through the PLATFORM's decoder,
 * which `bench/m23-blit/` measured is reachable from inside a locked-down process realm and only in
 * an AWAITED turn; `DOBJ_BITMAP` is this system's own `.rgba`, which is already an `encodeBitmap`
 * payload and needs `decodeBitmap` and no decoder at all. A format absent from this table is not a
 * failure and is not reported as one: there is nothing to decode, so the row keeps its type icon.
 *
 * THE KEYS ARE `src/libos/std.mjs`'S FORMAT IDS, which is the same association `formatForPath` and
 * `iconForPath` already read, so a `.png` here and a `.png` on the desktop are the same file.
 */
const THUMBNAILED = Object.freeze({
  [DOBJ_PNG]: "platform",
  [DOBJ_BITMAP]: "payload",
});

/**
 * THE LARGEST SQUARE ONE DATA OBJECT CAN HOLD, DEVICE px — DERIVED from the object ceiling and the
 * bitmap header, never written. 511 today.
 *
 * IT BINDS AT THE TOP OF THE VIEW-MODE RANGE AND NOT IN THEORY. `DOBJ_MAX_BYTES` is 1 MiB and a
 * pixel is four bytes, so a 512x512 payload is EIGHT BYTES over the ceiling — which is exactly the
 * Extra Large cell (256 CSS px) at dpr 2. A decode is clamped to this and the clamp is COUNTED,
 * because a thumbnail silently one pixel short of the cell it was asked for is a picture whose size
 * no reader could account for.
 */
const THUMB_MAX_SIDE = Math.floor(Math.sqrt((DOBJ_MAX_BYTES - BITMAP_HEADER) / 4));

/**
 * HOW MANY LIVE DATA OBJECTS THIS PROGRAM KEEPS BACK FOR ITS OWN GESTURES. A Cut, a Copy and a drag
 * each create one, and `DOBJ_CAP` is a PER-PROCESS count (`src/abi.mjs`) — so a thumbnail cache
 * allowed to fill it would make the next Copy answer -EMFILE, which is a file manager that stopped
 * being able to copy because a reader scrolled.
 *
 * FOUR AND NOT TWO: each of those three closes its fd inside the call that made it, so two would
 * do — the extra pair is headroom for a gesture that overlaps a repaint.
 */
const DOBJ_RESERVE = 4;

/**
 * HOW MANY THUMBNAILS MAY BE LIVE AT ONCE — `DOBJ_CAP` less the reserve, so 28.
 *
 * THIS IS THE ONE LIMIT A READER CAN SEE, and it is an ABI limit rather than a choice: `DL_BLIT`
 * draws a payload WHOLE and has no source rectangle, so an atlas is unexpressible and a picture
 * costs an object. A view showing more tiles than this draws the type icon on the remainder and
 * says how many — see `account.thumbs.capped`.
 */
const THUMB_CAP = DOBJ_CAP - DOBJ_RESERVE;

/**
 * THE LARGEST FILE THIS PROGRAM WILL READ WHOLE TO MAKE A PICTURE OF IT, bytes.
 *
 * A thumbnail needs the file's every byte — a decoder cannot start in the middle — and those bytes
 * cross the SAB `MAX_INLINE` at a time, so a 40 MiB PNG is 640 syscalls and 40 MiB of process heap
 * spent on a 16-pixel glyph. Above this the TYPE ICON is the honest answer and the size is said.
 * The row's own `lstat` already has the figure, so nothing is read to find out.
 */
const THUMB_SOURCE_MAX = 4 * 1024 * 1024;

/** How many payloads `account.thumbs.made` records before it starts counting instead. A reader
 *  scrolling a directory of four thousand images would otherwise carry four thousand rows out of
 *  the process; `madeCapped` is what says the list is short because of this and not because the run
 *  was. */
const THUMB_MADE_CAP = 64;

/**
 * THE DEVICE-PIXEL EXTENT A DECODE MUST PRODUCE for an `imgW` x `imgH` image in a `cellCss` square
 * at ratio `scale`. `{ w, h, clamped }`, both sides at least 1.
 *
 * IT IS THE PAYLOAD'S SIZE AND THEREFORE THE DRAWN SIZE, because `DL_BLIT` carries no destination
 * width or height — the renderer draws `BMP_W` x `BMP_H` surface pixels and scales nothing
 * (`src/wm/surface.mjs`). So the decode, and not the renderer, is what fits a picture to a cell,
 * and a dpr change invalidates every payload: a 16 CSS px glyph is 16 device px at dpr 1 and 32 at
 * dpr 2, and a cache that ignored the ratio would blit a half-size picture on half the displays —
 * the exact shape of defect that cost M11, M12 and M16 (CLAUDE.md).
 *
 * AN IMAGE PIXEL IS A CSS PIXEL UNTIL THE CELL IS SMALLER, which is the rule that decides what
 * "fit" means here: a 16x16 logo fills a 16 CSS px glyph box exactly and is NOT blown up to 256 in
 * the Extra Large view, because four hundred device pixels of interpolated 16x16 is a worse picture
 * than the icon it replaced. Only shrinking is a fit; growing is a guess.
 *
 * THE ASPECT RATIO IS KEPT. A letterboxed thumbnail is Explorer's own behaviour and the alternative
 * is a stretched one, which misreports the picture's shape — the one thing a thumbnail exists to
 * say.
 */
const thumbFit = (imgW, imgH, cellCss, scale) => {
  const longest = Math.max(1, imgW, imgH);
  const sideCss = Math.min(cellCss, longest);
  const toCell = sideCss / longest;
  let w = Math.max(1, Math.round(imgW * toCell * scale));
  let h = Math.max(1, Math.round(imgH * toCell * scale));
  // THE OBJECT CEILING, APPLIED LAST AND REPORTED. It binds only at the top of the view-mode range
  // (see `THUMB_MAX_SIDE`), and a clamp nobody counted is a picture a reader cannot account for.
  const over = Math.max(w, h) / THUMB_MAX_SIDE;
  if (over <= 1) return { w, h, clamped: false };
  w = Math.max(1, Math.floor(w / over));
  h = Math.max(1, Math.floor(h / over));
  return { w, h, clamped: true };
};

/** THE IN-SURFACE MENU'S GEOMETRY, CSS px, and it exists ONLY for `--menu-in-surface`. The real
 *  menu is the page's popup and its metrics are the shell's; these are what the control draws with,
 *  exported so a check can predict the rectangle rather than restate it. */
const MENU_ROW_H = 20;
const MENU_W = 148;
const MENU_PAD = 4;

/**
 * THIS PROGRAM'S ROW GEOMETRY, EXPORTED — because things outside the process need it and each copy
 * is a copy that drifts.
 *
 * `www/m10.html` drives a REAL mouse onto a row and `bench/m10-data/shell.py` does the same at a
 * prompt; both used to restate `ROW_H = 22` and `ROW_GAP = 4` beside their own `rowMid`, and
 * CLAUDE.md listed them as a known second copy with the consequence spelled out: "a drift there
 * arrives as the WRONG FILE being dragged, which the run prints". M15 made that true — the rows
 * moved down by a header and shrank by 2 px — so the copies went.
 *
 * EVERY LENGTH HERE IS A CSS PIXEL, AND M16 IS WHY THAT NOW HAS TO BE SAID. The surface is the
 * client box in DEVICE pixels, so a driver that wants surface coordinates converts with
 * `toSurface(v, scale)` — the same arithmetic the program draws with, which is the point of
 * exporting it rather than a number. The honest `scale` for a driver is MEASURED, not assumed:
 * `canvas.width / canvas.getBoundingClientRect().width`. A driver working in page coordinates
 * needs no scale at all, because the canvas's CSS box IS the client area these are measured in —
 * `rect.left + xCss` is the point.
 *
 * `SURFACE_W` IS THE OPENING WIDTH AND NO LONGER THE LIVE ONE. It cannot be live: a page imports
 * this module into its own realm, and the running process has another — two module instances, so
 * no exported binding can carry the program's state. The live width is readable where it is
 * actually true, off the canvas.
 *
 * M17: THE SCROLL OFFSET IS A PARAMETER OF THE ROW ARITHMETIC, for the same reason. The offset is
 * the running process's state and no export can carry it either, so `rowTop`, `rowMid` and `rowAt`
 * take it — defaulting to 0, which is every pre-M17 caller's unscrolled list and why none of them
 * had to change. A driver that scrolled the list reads the offset the program REPORTS (`scroll` in
 * its account, and the line it prints on exit) and passes it here; `scrollMax` is what the end
 * clamps are, so a driver can assert the clamp against the program's own arithmetic rather than a
 * number of its own.
 *
 * M18: `focusBox` IS HERE FOR THE SAME REASON `rowTop` IS. The keyboard cursor's ring is a
 * rectangle inset inside a row, and a driver that wanted to read its pixels would otherwise restate
 * the inset — which is the drift this export exists to stop, one pixel's worth of it. The ROW
 * GEOMETRY ITSELF DID NOT MOVE: the ring is drawn inside the row it marks, so `rowTop` and `rowMid`
 * mean exactly what they meant before and the drivers that aim at them need no change.
 *
 * M19: THE COLUMNS AND THE TWO CELL FORMATTERS ARE HERE, AND THE ROW GEOMETRY DID MOVE. `FOOT_H`
 * is a new term in `viewBox`, `scrollMax`, `rowsThatFit` and `clientHeightFor` — all four of which
 * are exported, so a driver that already asks here follows it and a driver that restated one of
 * them does not. `columnBoxes` is what a header press must be aimed with and `columnAt` is its
 * declared inverse; `dateText` and `sizeText` are exported so a driver can PREDICT a cell rather
 * than restate the format, which is the same argument `rowTop` is exported under. The cells the
 * program actually drew are in its account, row by row, so the two readings can be compared.
 * `bandBox` and `bandRows` are here for the same reason again: which rows a rubber band took is
 * an intersection, and a driver restating it is a driver asserting the wrong set.
 */
export const FILES_METRICS = Object.freeze({
  ROW_H, ROW_GAP, ROW_STRIDE, PAD, HEAD_H, VIEW_TOP, FOOT_H, NAME_X, GLYPH_W, TEXT_PX, FOCUS_INSET,
  SURFACE_W: START_W,
  COLUMNS, SORT_DEFAULT, DATE_W, TYPE_W, SIZE_W, NAME_MIN_W, UNKNOWN_CELL,
  rowTop, rowMid, rowAt, toSurface, viewBox, scrollMax, rowsThatFit, clientHeightFor, focusBox,
  columnBoxes, columnAt, dateText, sizeText, bandBox, bandRows,
  /* M20. THE VERB NAMES, so a check asserts `account.chosen` against this table rather than against
   * string literals of its own, and `nameFault` so a driver can predict which names this program
   * will refuse. `MENU_*` are the `--menu-in-surface` control's drawing only — the real menu is the
   * PAGE's popup and its metrics belong to the shell. */
  VERBS: Object.freeze({
    OPEN: V_OPEN, NEW_FOLDER: V_NEW_FOLDER, RENAME: V_RENAME, DELETE: V_DELETE,
    CUT: V_CUT, COPY: V_COPY, PASTE: V_PASTE, RESTORE: V_RESTORE,
  }),
  NEW_FOLDER_STEM, nameFault, baseNameOf,
  MENU_ROW_H, MENU_W, MENU_PAD,
  /* M21. THE BIN'S TWO NAMES AND THE TWO FUNCTIONS THAT BUILD THEM, for `rowTop`'s reason: a check
   * asserting that a delete left a payload AND an origin record has to name both paths, and a
   * driver that restated either would assert against a Bin this program does not have. */
  BIN_NAME, ORIGIN_SUFFIX, binDirIn, originRecordOf, freeFrom,
  /* M23. THE THUMBNAIL'S THREE CEILINGS AND ITS FIT, for `rowTop`'s reason: a check asserting that
   * a blit drew the picture a reader asked for has to name the payload's EXTENT, and that extent is
   * a function of the ratio — so a driver restating it is a driver asserting the wrong rectangle at
   * every dpr but its own. `THUMB_CAP` is here because it is the one limit a reader can SEE: a view
   * with more tiles than this has type icons on the remainder, by construction and not by failure.
   *
   * `THUMB_FORMATS` is the ids of `THUMBNAILED`'s rows, as numbers, so a driver can tell a row with
   * nothing to decode from one whose decode was refused without restating the table. */
  THUMB_MAX_SIDE, THUMB_CAP, THUMB_SOURCE_MAX, thumbFit,
  THUMB_FORMATS: Object.freeze(Object.keys(THUMBNAILED).map(Number)),
  /* M23. THE VIEW MODES AND THE GENERALISED GEOMETRY, for `rowTop`'s reason once more — and with
   * one extra obligation this time. The six functions below each DELEGATE to the exported Details
   * function in the `rows` flow (`itemBox`→`rowTop`, `itemAtPoint`→`rowAt`, `scrollMaxFor`→
   * `scrollMax`, `pageStepFor`→`rowsThatFit`, `focusBoxFor`→`focusBox`, `bandItems`→`bandRows`), so
   * a driver that already aims with the old names is aiming at the same pixels and a driver in
   * another mode has one place to ask. The `VIEWS` table is the data: `label` is what a reader is
   * shown, `thumbs` is R26's scope, and `id` is what `--view` takes and `account.view` reports. */
  VIEWS, VIEW_BY_ID, VIEW_DEFAULT, CELL_GAP, LABEL_H,
  FLOW_ROWS, FLOW_GRID, FLOW_COLUMNS,
  cellHOf, lanesOf, axisOf, itemBox, itemAtPoint, contentLength, scrollMaxFor, pageStepFor,
  laneStepFor, focusBoxFor, bandItems,
  /* M23. THE ADDRESS STRIP AND THE SEARCH FIELD, for `rowTop`'s reason and one more: `HEADER_MID`
   * and `CRUMB_MID` exist so that nothing outside this process has to halve `VIEW_TOP` to name a
   * band. That arithmetic was right while the column header was the only thing above the viewport
   * and is now a point whose band depends on `CRUMB_H < HEAD_H` — see `CRUMB_H`. `crumbSegments` is
   * the rectangle a segment press must be aimed at and `crumbHit` is its declared inverse. */
  CRUMB_H, CRUMB_TOP, CRUMB_SKIRT, CRUMB_PAD, CRUMB_MID, HEADER_MID, SEARCH_W, VIEWBTN_W,
  MONO_ADVANCE_PER_PX,
  crumbSegments, crumbHit,
  searchMatch, SEARCH_MAX_DEPTH, SEARCH_MAX_ENTRIES, SEARCH_CHUNK,
});

const PAPER = 0x12161cff;
const OUTLINE = 0xdde3ebff;
/** A row's colour IS ITS FORMAT, because that is the only thing a reader can see without text. */
const BAND = {
  [DOBJ_PNG]: 0x4a9bd8ff,
  [DOBJ_BITMAP]: 0x9fd4a8ff,
  [DOBJ_TEXT]: 0x8a8f98ff,
};
const BAND_UNKNOWN = 0x3a3f48ff;
/* THE INK. A list is read, so the contrast between these and `PAPER` is the whole of whether it
   works — and the selected row inverts, which is what every file manager does. */
const INK = 0xe8edf4ff;
const INK_DIM = 0x97a1afff;
const INK_SELECTED = 0x0b1118ff;
const HEAD_INK = 0xbcc8d6ff;
const HEAD_RULE = 0x2a313bff;
const SELECT_FILL = 0x9fd4a8ff;
const SELECT_FILL_DIR = 0xe8aa3cff;
/** A DIRECTORY'S BAND, which is a kind rather than a format: amber, because that is the colour the
 *  shell's folder icon is drawn in (`src/wm/icons.mjs`) and a reader should see one thing. */
const BAND_DIR = 0xe8aa3cff;
/** THE KEYBOARD CURSOR'S RING, and it is its own HUE rather than its own brightness: the selection
 *  already owns a filled band outlined in `OUTLINE`, so a second near-white rectangle would make
 *  "focused" and "selected" the same picture — which is the state a press on the header produces,
 *  and the one a reader most needs to tell apart. */
const FOCUS_RING = 0x8fd0ffff;
/**
 * THE HOVER'S BAND, AND IT IS A FILL RATHER THAN AN INK.
 *
 * A lit row and a selected row must stay two readings. The selection already owns a name's COLOUR —
 * which is the only property a reader outside the surface can tell one row from another by
 * (`www/m18.html` reads the selection as the minority ink, with no geometry in the test) — so a
 * hover that changed an ink would make "lit" and "selected" the same fact seen twice, and a check
 * for either would answer for both. This sits UNDER the text and changes no ink at all.
 *
 * ONE STEP OFF `PAPER` AND NO MORE: a hover is a hint that the pointer is here, not a selection.
 */
const LIT_FILL = 0x1e2630ff;
/** THE RUBBER BAND: a translucent wash inside a solid edge, which is what makes a band over a lit
 *  or selected row read as a band over it rather than as a third selection colour. The alpha is the
 *  low byte and `cssColor` is what turns it into a canvas `rgba()` (constraint 224). */
const BAND_WASH = 0x4a9bd83c;
const BAND_EDGE = 0x8fd0ffff;
/** M23. THE ADDRESS STRIP'S OWN TWO TONES: the strip is one step off the paper so a reader can see
 *  where it ends, and a segment under the pointer is one step off that. `CRUMB_FILL` doubles as the
 *  search field's and the view button's ground, because they are the same strip. */
const CRUMB_FILL = 0x1a2027ff;
const CRUMB_LIT = 0x27313cff;
/** M23. WHAT A LETTERBOXED THUMBNAIL SITS ON. `thumbFit` keeps the aspect ratio, so a non-square
 *  picture leaves bars inside its cell — and a bar of `PAPER` makes a 64x16 strip read as a drawing
 *  that stopped rather than as the shape of the image. One step off the paper, like `LIT_FILL`:
 *  a plate is a statement about the cell, not a second selection colour. */
const THUMB_PLATE = 0x1a2027ff;

/**
 * HOW FAR THE POINTER MUST MOVE BEFORE A PRESS BECOMES A DRAG, in CSS pixels.
 *
 * IT WAS SURFACE PIXELS AND THE NUMBER DID NOT MOVE, because the coordinate did. A pointer event
 * carries surface pixels and is converted once, at `cssPointAt`, so every comparison below it is
 * in the reader's unit — and a threshold that stayed in surface pixels would be 3 device pixels,
 * which is 1.5 CSS pixels at dpr 2: half a hand tremor, and every click a drag.
 *
 * A PRESS ALONE MUST NOT START ONE: every click on a row would otherwise begin a gesture that ends
 * on the next pointerup, and the kernel's single session would spend its life being started and
 * cancelled. Windows has the same threshold for the same reason.
 *
 * THE HYSTERESIS IS THE PRESS AND NOT A SECOND DISTANCE. The threshold arms once per press and the
 * release disarms it, so a drag that comes back inside 3 px is still a drag — a distance test on
 * the way down would make one gesture several. `www/m10.html` drives both edges: a 1 px move must
 * start nothing and a long one must start exactly one session.
 */
const DRAG_THRESHOLD_CSS_PX = 3;

function unInterrupted(call) {
  const first = call();
  if (first !== -EINTR) return first;
  return call();
}

/** Read a whole file, or a negative errno. */
function readFile(env, path) {
  const fd = env.fs.open(path, O_RDONLY);
  if (fd < 0) return fd;
  try {
    return env.std.slurp(env, fd);
  } finally {
    env.fs.close(fd);
  }
}

/**
 * M23 MADE THIS ASYNC, AND THE REASON IS A MEASUREMENT RATHER THAN A STYLE.
 *
 * A thumbnail needs a decode, and `bench/m23-blit/` measured that a decode promise settles inside a
 * real process in M6's stripped realm under its live CSP — but ONLY in an awaited turn: not while
 * the process is parked in `nanosleep` (406 ms, nothing settled), not while it spins (400 ms), and
 * a cold decode needs seven macrotask turns in Chrome. So the decode cannot be folded into a
 * syscall reply — constraint 219's shape, which M8 established for a transferred `OffscreenCanvas`,
 * holds for a promise too — and the only honest place for it is BETWEEN two syscalls, as an `await`
 * the event loop can reach. `src/libos/process.mjs` already awaits a program's `run`.
 *
 * NOTHING ELSE IN HERE BECAME ASYNCHRONOUS. Every syscall is still the blocking call it was; the
 * only suspension points are `fillThumbs`'s, and they are all before the poll.
 */
export async function run(env) {
  const argv = (env.argv || []).map(String);
  /* THE TWO CONTROLS COME OFF ARGV BEFORE `getopt`, which knows single letters only — a
   * `--no-resurface` reaching it is refused as an unknown `-`. `--` still ends the options, so a
   * directory named like a flag stays reachable. The long-option loop is `src/bin/term.mjs`'s
   * convention (`--title`, `--run`, `--ceiling`). */
  let frozenSurface = false;
  let cssPxSurface = false;
  let unclampedScroll = false;
  let stableSortOff = false;
  let foldersLast = false;
  let noDirStat = false;
  let bandFromRow = false;
  let menuInSurface = false;
  let pasteClobbers = false;
  let restoreOverwrites = false;
  let moveForcedCopy = false;
  let staleListing = false;
  /** M23's two thumbnail controls. `noThumbs` decodes nothing; `thumbNoFallback` decodes and then
   *  draws NOTHING where a decode was refused or capped, which is the silent-blank world R26's
   *  "stated fallback" clause is about. */
  let noThumbs = false;
  let thumbNoFallback = false;
  let noDrainMs = 0;
  /** `--bin`: open the Bin rather than the session tree. Resolved AFTER the options, because
   *  where the Bin is comes from `binDirIn` and not from the caller. */
  let openBin = false;
  /** `--view ID`: the mode the window OPENS in. NOT a control and not a fixture — it is how a
   *  reader, a desktop row or a driver names a view without a gesture, which the ABI cannot deliver
   *  by keyboard (see `WHAT CANNOT BE BOUND` in this file's header). An unknown id is refused by
   *  name rather than silently defaulted: a window that opened in Details because a word was
   *  misspelled is a window that lies about what it was asked for. */
  let openView = "";
  const rest = [];
  let endOfOptions = false;
  const args = argv.slice(1);
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!endOfOptions) {
      if (arg === "--") { endOfOptions = true; rest.push(arg); continue; }
      if (arg === "--no-resurface") { frozenSurface = true; continue; }
      if (arg === "--css-px-surface") { cssPxSurface = true; continue; }
      if (arg === "--unclamped-scroll") { unclampedScroll = true; continue; }
      if (arg === "--stable-sort-off") { stableSortOff = true; continue; }
      if (arg === "--folders-last") { foldersLast = true; continue; }
      if (arg === "--no-dir-stat") { noDirStat = true; continue; }
      if (arg === "--band-from-row") { bandFromRow = true; continue; }
      if (arg === "--menu-in-surface") { menuInSurface = true; continue; }
      if (arg === "--paste-clobbers") { pasteClobbers = true; continue; }
      if (arg === "--restore-overwrites") { restoreOverwrites = true; continue; }
      if (arg === "--move-forced-copy") { moveForcedCopy = true; continue; }
      /* `--bin`: OPEN THE BIN, without the caller naming where it is.
       *
       * `src/bin/desktop.mjs` publishes the Recycle Bin row as `["files", "--bin"]` on purpose —
       * the row names the LOCATION and where that location is stays in the one program that puts
       * things there, so a path written in the desktop is a second definition of this file's
       * `binDirIn`. That reasoning is right and the flag was simply never implemented: the desktop
       * published it, `getopt` refused it as an unknown option, and a real double-click on the
       * Recycle Bin icon opened nothing. `bench/m21-bin/firefox-bin.py` is what found it, by
       * clicking the icon a reader clicks — the registered suite stages the Bin directly and so
       * could not see it. */
      if (arg === "--bin") { openBin = true; continue; }
      if (arg === "--stale-listing") { staleListing = true; continue; }
      if (arg === "--no-thumbs") { noThumbs = true; continue; }
      if (arg === "--thumb-no-fallback") { thumbNoFallback = true; continue; }
      if (arg === "--view") {
        const raw = args[i + 1];
        if (raw === undefined || !VIEW_BY_ID[raw]) {
          return {
            exit: env.std.complain(env, NAME, raw === undefined ? "--view" : String(raw),
              `--view wants one of ${VIEWS.map((v) => v.id).join(", ")}`, env.std.EXIT_USAGE),
            program: NAME,
          };
        }
        openView = raw;
        i += 1;
        continue;
      }
      if (arg === "--no-drain") {
        // Refused, not silently defaulted — `--ceiling`'s rule in src/bin/term.mjs: `Number(x) || d`
        // accepts both `0` and `abc`, and a fixture that silently did not hold is a check that
        // passed over a draining program.
        const raw = args[i + 1];
        const ms = Number(raw);
        if (raw === undefined || !Number.isFinite(ms) || ms <= 0) {
          return {
            exit: env.std.complain(env, NAME, raw === undefined ? "--no-drain" : String(raw),
              "--no-drain wants a positive number of milliseconds", env.std.EXIT_USAGE),
            program: NAME,
          };
        }
        noDrainMs = ms;
        i += 1;
        continue;
      }
    }
    rest.push(arg);
  }
  const { operands, bad, why: badWhy } = env.std.getopt(rest, "");
  if (bad) {
    return { exit: env.std.complain(env, NAME, bad, badWhy, env.std.EXIT_USAGE), program: NAME };
  }
  /* M19a. AN OPERAND IS THE READER'S WORD AND IS NEVER SECOND-GUESSED: a named directory that is
   * not there must answer ENOENT by name, not be replaced with somewhere that works. The fallback
   * belongs to the case where nobody named one. */
  const opened = operands[0]
    ? { dir: operands[0], home: false, why: "" }
    : openBin
      /* THE BIN IS NAMED HERE AND NOT BY THE CALLER, which is the whole point of `--bin`. An
       * explicit operand still wins: a reader who typed a directory meant it (the rule above). */
      ? { dir: binDirIn(env.std.HOME_DIR), home: false, why: "" }
      : env.std.sessionDir(env);
  if (opened.why) {
    env.std.warn(env, `${NAME}: no session tree (${opened.why}), opening ${opened.dir}, `
      + "which is the base's own data directory and is READ-ONLY");
  }
  /** WHERE THE WINDOW IS, AND IT MOVES. M18 re-lists in place, so the directory is state rather
   *  than an argument — and `history` is the stack Back pops. */
  let dir = opened.dir;
  const history = [];
  const t0 = performance.now();
  /** THE BIN, AND IT IS THE SESSION TREE'S AND NOT THIS WINDOW'S. `std.HOME_DIR` is where the
   *  writable copy of the read-only base lives (D40), so it is the one place a `rename` out of a
   *  reader's own directory can land — a Bin per window would be a second place to look for a file
   *  and a Bin per mount would be one in a tree the reader never opens. */
  const binRoot = binDirIn(env.std.HOME_DIR);
  /** Whether this window is LOOKING AT the Bin, which is what makes Restore a verb and a Delete
   *  final. Compared on `dirKey`, so an operand with a trailing slash names the same directory a
   *  double-click does. */
  const inBin = () => dirKey(dir) === dirKey(binRoot);
  /** Whether a path may go TO the Bin rather than being removed: inside the session tree, and not
   *  already in the Bin. The second half is not a detail — a Bin that recycled its own rows would
   *  be a delete a reader could never finish. */
  const binnable = (path) => underDir(path, env.std.HOME_DIR) && !underDir(path, binRoot);
  /* ---- M23: THE VIEW MODE, AND IT IS REMEMBERED PER FOLDER --------------------------------- */

  /** THE MODE THIS WINDOW IS IN — a row of `VIEWS` and never an id, so nothing downstream has to
   *  look one up and no call site can hold a string the table does not have. */
  let view = VIEW_BY_ID[openView] || VIEW_BY_ID[VIEW_DEFAULT];
  /**
   * dirKey -> mode id. R27's "remembered per folder", and it is THIS PROCESS'S memory and says so.
   *
   * IN MEMORY AND NOT ON DISK, which is a limit rather than a shortcut: there is no agreed place for
   * persisted shell configuration (`docs/PLAN-SHELL.md` §6 lists it as open), and inventing a dotfile
   * here would be a second answer to a question R24's pin list asks too. So a reader who sets Large
   * icons on a folder, walks away and comes back in the SAME window finds Large icons; a new window
   * opens in the default. That is stated on stdout rather than implied.
   *
   * KEYED ON `dirKey` so a path with a trailing slash and the same path without one are one folder,
   * which is the same normalisation `inBin` compares with.
   */
  const viewByDir = new Map();

  const account = {
    program: NAME, dir, win: 0, fd: 0, rows: [], drags: 0, refusedDrags: 0,
    /* M19a. WHO CHOSE THE DIRECTORY, and why it is not the session's tree when it is not: `dir`
     * alone cannot tell a reader's own operand from the read-only fallback, and those are the two
     * worlds D40 is about. THREE VALUES AND NOT A BOOLEAN — `argv`, `session`, `fallback` — because
     * an operand may name the session's tree or anywhere else, and a flag would have to lie about
     * one of them. `dirWhy` is "" except under `fallback`. */
    dirFrom: operands[0] ? "argv" : (opened.home ? "session" : "fallback"),
    dirWhy: opened.why,
    pointers: 0, presses: 0, drops: [], effects: [], why: "",
    // M16. The geometry, in both units, and what happened to it: `surface` is DEVICE px (what the
    // kernel granted), `client` is CSS px (what the layout is in), `dpr` is the factor.
    clients: 0, resurfaces: 0, refusedSurfaces: 0, surfaceWhy: "",
    surface: { w: 0, h: 0 }, client: { w: 0, h: 0 }, dpr: 1,
    /* M17. THE SCROLL STATE, IN CSS PIXELS, AND WHAT THE WHEEL DID TO IT. `scroll` is where the
     * list sits and `scrollMax` is its bottom clamp, so a driver reads both and needs neither
     * restated. `dyTotal` is the SUM OF EVERY DELTA ASKED FOR, clamped or not — the clause "the
     * offset equals the full summed delta" is `scroll === dyTotal`, and it separates a lost notch
     * from a notch the clamp ate. `clamped` counts each end, because both edges are asserted and a
     * single "it clamped" passes for a list that only ever hit one of them. */
    wheels: 0, coalescedWheels: 0, pageWheels: 0, scroll: 0, scrollMax: 0, dyTotal: 0,
    clamped: { top: 0, bottom: 0 },
    /* THE VIEWPORT'S CONTENTS. `firstRow` is the row at the top of it and `shownRows` is how many
     * were DRAWN, which is `maxRows` plus the one the clip cuts in half — a scrolled list almost
     * always has a partial row at an edge, so the two numbers differ by design and neither is the
     * other's bound. Nothing is HIDDEN any more: `rows.length - shownRows` is what the reader
     * scrolls to rather than what they are told about. */
    maxRows: START_ROWS, shownRows: 0, firstRow: 0,
    /* M18. THE CURSOR, THE NAVIGATION AND EVERY REFUSAL. `focus` is the keyboard cursor's row and
     * `-1` is "nothing is focused", which is a state and not an absence — a first Enter in it is a
     * refusal and the count below is where that is visible. `refusals` carries each one BY NAME,
     * because a counter alone passes for a window that refused the wrong thing. */
    focus: -1, keysyms: 0, dblclicks: 0, activations: 0, relists: 0, backs: 0,
    spawned: [], refused: 0, refusals: [], refusalWhy: "", history: 0,
    /* M19. THE SORT, THE SELECTION, THE BAND, THE HOVER AND WHAT THE `lstat` COST.
     *
     * `sort.chosen` is whether a reader has clicked a header at all, and it is a state rather than
     * a convenience: the first click on the DEFAULT column is a choice and not a reversal, so
     * without it that click would turn the list over.
     *
     * `selected` IS THE SET, IN ASCENDING INDEX ORDER, because a set of row indices read back out
     * of a program is the only statement of a Shift range a check can assert, and `anchor` is the
     * other half — a Ctrl+press that did not move the anchor is invisible in the set alone.
     *
     * `stats` AGAINST `dirStats` IS THE EVIDENCE THE DIRECTORY CALL IS PAID. One `lstat` per row,
     * directories included, so `stats === rows.length` after a listing and `dirStats` is how many
     * of them were the call that used to be skipped. `--no-dir-stat` drops the second to zero. */
    sort: { key: SORT_DEFAULT.key, dir: SORT_DEFAULT.dir, chosen: false }, sorts: 0,
    selected: [], anchor: -1, selects: 0,
    bands: 0, bandSelected: 0,
    hovers: 0, leaves: 0, lit: -1,
    stats: 0, dirStats: 0, cappedRows: 0,
    /* M20. THE MENUS, THE VERBS AND WHAT EACH ONE DID TO THE FILESYSTEM.
     *
     * `menus` against `refusedMenus` and `dismissals` is the menu's own arithmetic: a raise, a
     * refused raise and a close with nothing chosen are three outcomes and a single counter passes
     * for the wrong one. `menuRows` is the LABELS of the open menu, so a check can assert that a
     * right-click on a row and one on empty space produce two different lists without reading the
     * page's popup; `menuTarget` is the row it was raised on, `-1` for empty space.
     *
     * `created`/`renamed`/`deleted`/`pasted` ARE WHAT THE FILESYSTEM NOW HOLDS, by name, and
     * `rows` beside them is a fresh `readdir` of the same directory — so "the directory appears in
     * a fresh listing" is an assertion over two independent readings and not over this program's
     * belief about its own `mkdir`.
     *
     * `clipboard` IS THE INTENT AND THE PATHS, and it is this process's own record for the reason
     * in this file's header: the published object is sealed and carries no cut/copy field. */
    menus: 0, refusedMenus: 0, dismissals: 0, chosen: [],
    menuRows: [], menuTarget: -1, menuInSurfaceAt: null,
    created: [], renamed: [], deleted: [], pasted: [],
    clipboard: null, copies: 0, cuts: 0, pastes: 0,
    renaming: null, renames: 0,
    /* M21. THE BIN, THE REFRESH, AND BOTH ENDS OF A DRAG.
     *
     * `bin.binned` and `bin.restored` ARE THE PAIRS A CHECK READS: each entry names the payload and
     * the path its origin record carries, so "a delete left the bytes reachable" and "a restore
     * returned them" are two readings of two different records rather than one counter twice.
     * `bin.permanent` is the other half of a Delete — a row outside the session tree, which has no
     * Bin to reach — and `bin.stranded` counts an origin record this program could not take back,
     * because a record whose payload is not there names nothing a reader can act on.
     *
     * `refreshes` AGAINST `refreshKept` is F5's whole clause: the keysym arrived, the directory was
     * re-read, and the selection survived FOR THE ROWS THAT SURVIVED — `kept` is how many of the
     * names asked for came back, which is the number a row that is gone must not raise.
     *
     * `effectsOffered` is what THIS program asked the kernel for, beside `effects` which is what
     * the kernel reported back. Two readings, because the modifier decides the first and only the
     * kernel decides the second (`src/kernel/dataobj.mjs` picks COPY whenever the mask holds it). */
    bin: {
      dir: binRoot, binned: [], restored: [], permanent: 0, stranded: 0, strandedRecords: 0,
      listing: false,
    },
    /* M23. THE VIEW MODE, AND BOTH HALVES OF IT.
     *
     * `view` is the id a reader is in and `viewLabel` is the words they are shown, because a check
     * asserting "the window says Large icons" and one asserting "the layout is the large grid" are
     * two readings and a single field would make them one. `lanes` is how many cells fit across the
     * fixed axis, which is the number a driver needs to know where the second row of a grid is;
     * `viewAxis` is which way the mode scrolls, because `scroll` is an offset along it and the List
     * is the one mode where that is an x.
     *
     * `viewsRemembered` is R27's per-folder memory as a COUNT of folders, so a check can tell a
     * window that remembered from one that happened to open in the same mode.
     */
    view: view.id, viewLabel: view.label, viewFlow: view.flow, viewAxis: axisOf(view),
    viewSwitches: 0, viewFrom: openView ? "argv" : "default", lanes: 1, viewsRemembered: 0,
    /* M23. THE ADDRESS STRIP AND THE SEARCH.
     *
     * `crumbs` IS THE TRAIL AS DRAWN, label and path per segment, so a check asserts that pressing
     * the third segment went to the path the third segment NAMED rather than to a path it worked
     * out itself. `crumbNav` counts the navigations that came from one, apart from `relists` — a
     * breadcrumb that silently did nothing and a breadcrumb that re-listed look the same in the
     * row count alone.
     *
     * `query` AGAINST `matched` AND `listed` IS R31'S WHOLE CLAUSE: what was typed, how many rows
     * survived it, and how many there were. `searchCost` is what the row asked to be said plainly —
     * `dirsRead` and `entriesSeen` are what a WALK paid, and both are 0 for the free filter, which
     * is the distinction R31 is about.
     *
     * `strip` is which of the three states the strip is in, because an open path field and an open
     * search field take the keyboard and a check needs to know which one it is typing into.
     */
    crumbs: [], crumbNav: 0, pathEdits: 0, pathWas: "",
    strip: "trail", stripDraft: "",
    query: "", matched: 0, listed: 0, searches: 0, deepSearches: 0,
    searchCost: { dirsRead: 0, entriesSeen: 0, statted: 0, ms: 0, chunks: 0, why: "" },
    statMs: 0,
    refreshes: 0, refreshKept: 0,
    dragEnters: 0, dragLeaves: 0, dropsIn: 0,
    dragOffers: [], dropped: [], dropWhere: [],
    effectsOffered: [], movedOut: [],
    /* M23. THE THUMBNAILS, AND THE FALLBACK IS COUNTED APART FROM THEM.
     *
     * `ready` AGAINST `fellBack` IS THE WHOLE OF R26: a row whose picture is its own bytes, and a
     * row that was asked for one and got the TYPE ICON instead with the reason named. The two are
     * separate counters because a single "no thumbnail" passes for a program that never tried —
     * which is `--no-thumbs`, and which moves `decoded` to 0 while leaving `wanted` where it was.
     *
     * A FALLBACK IS NOT A REFUSAL AND IS NOT IN `account.refusals`. `refuse` is for something a
     * reader ASKED FOR and did not get; a thumbnail nobody requested that degraded to the icon the
     * row would have had anyway is a statement about a picture, not a declined command — and
     * putting it in `refusals` would make every window over a directory of broken images report
     * refusals a check cannot tell from a refused Delete.
     *
     * `rows` NAMES EACH ONE: the path, the payload's DEVICE extent and the reason it fell back, so
     * a check reads the extent the program really produced rather than the one it computed.
     */
    thumbs: {
      wanted: 0, ready: 0, decoded: 0, fellBack: 0, capped: 0, clamped: 0,
      evicted: 0, released: 0,
      /* `bytes` IS THE LAST FILL PASS'S AND `peakBytes` IS THE HIGH-WATER MARK, and the pair is
       * needed rather than tidy: a reader who walks out of a directory of images leaves `bytes` at
       * 0 while having held a megabyte, so a check that read only the live figure would be unable
       * to tell that program from one that never decoded anything. */
      bytes: 0, peakBytes: 0, maxSide: THUMB_MAX_SIDE, cap: THUMB_CAP, decodeMs: 0,
      rows: [], why: "",
      /* EVERY PAYLOAD EVER MADE, in order, capped — `{path, w, h, bytes}`.
       *
       * `rows` IS THE LIVE CACHE AND THIS IS THE CUMULATIVE RECORD, and the pair is needed for
       * `peakBytes`'s reason: a window that walked out of the directory it decoded in has an empty
       * `rows`, so nothing in the live reading says what extent a payload had. The EXTENT is the
       * figure that matters — `thumbFit` is where the display's ratio enters, and a payload made at
       * the wrong size is the whole class of defect that cost M11, M12 and M16.
       *
       * CAPPED, because a reader scrolling a directory of four thousand images would otherwise
       * carry four thousand rows out of the process in the result. The cap is stated in
       * `madeCapped`, so a short list is never mistaken for a short run. */
      made: [], madeCapped: 0,
      /* WHAT THE LAST FRAME DREW: pictures and type icons. Their SUM is how many items were drawn
       * with a mark of either kind, so `drewPictures + drewIcons === shownRows` is R26's fallback
       * clause as arithmetic — and `--thumb-no-fallback` is the world where it does not hold. */
      drewPictures: 0, drewIcons: 0,
    },
    controls: {
      frozenSurface, cssPxSurface, unclampedScroll,
      stableSortOff, foldersLast, noDirStat, bandFromRow,
      menuInSurface, pasteClobbers,
      restoreOverwrites, moveForcedCopy, staleListing,
      noThumbs, thumbNoFallback,
    },
    // A FIXTURE AND NOT A CONTROL (see this file's header), so it is reported apart from them.
    noDrainMs, heldMs: 0,
  };

  /* A ROW PER ENTRY, AND A DIRECTORY IS AN ENTRY — which M14 is why: `files /` showed NOTHING,
   * because the root holds only directories and this program listed only files whose format it
   * knew. So a double-click on the desktop's Computer icon opened a program that exited at once
   * with "no file here has a known format", and a reader saw a live-looking icon do nothing. A
   * file manager that cannot show a folder is not a file manager.
   *
   * A DIRECTORY IS NOT A DRAG SOURCE. It has no format — there are no bytes to offer, and a
   * program that put a directory's PATH under TEXT would be making the guess a typed clipboard
   * exists to refuse (constraint 247) — so its band is drawn in the unknown colour and
   * `startDrag` refuses it by name. A FILE no format rule covers is kept for the same reason the
   * directory is: a row a reader can see and cannot drag is honest, and an invisible file is not.
   */
  /** THE SORT A READER CHOSE, or the default nobody chose. `chosen` is what makes the first click
   *  on the `Name` header a choice rather than a reversal (this file's header). */
  let sort = { key: SORT_DEFAULT.key, dir: SORT_DEFAULT.dir, chosen: false };

  /** THE ORDER, APPLIED TO A LIST IN PLACE. One call site per list — `buildRows` for a new
   *  directory and the header press for a new column — so the comparator cannot be applied with one
   *  set of controls here and another there. `order` is a parameter because `relist` sorts a list it
   *  has not committed yet, with a sort state it has not committed either. */
  const sortRows = (list, order = sort) => list.sort((a, b) =>
    compareRows(a, b, order, { foldersLast, stableSortOff }));

  /**
   * THE LIST AS THE ACCOUNT CARRIES IT: one entry per row, IN LAYOUT ORDER, with the four CELLS
   * THIS PROGRAM DREW.
   *
   * `cells` is `cellOf`'s output and nothing else, so what a check reads is what a reader saw — a
   * driver that formatted a date of its own would be a second renderer of one fact. The numbers are
   * beside them because a sort is asserted on the VALUE and not on the spelling, and `format` keeps
   * the name it has had since M10: it is `kindOf`, which is the type cell.
   */
  const reportRows = () => rows.map((r) => ({
    name: r.name, format: kindOf(r), dir: r.dir, size: r.size, mtimeMs: r.mtimeMs,
    statted: r.statted,
    // M21. `""` outside the Bin and for a payload with no record: the two are told apart by
    // `bin.listing`, which says whether the lookup was paid at all.
    origin: r.origin || "",
    cells: Object.fromEntries(COLUMNS.map((c) => [c.key, cellOf(r, c.key)])),
  }));

  /**
   * ONE ROW, FROM A DIRECTORY `base` AND AN ENTRY NAME. The ONE place a `dirent` becomes a row —
   * `buildRows` reads a directory with it and M23's search walk reads a whole TREE with it, so a
   * search result and a listing row describe a file the same way. Two copies would be two opinions
   * about what the Type cell says, and the type is what decides whether a row can be dragged.
   *
   * THE KIND, WHICH IS WHAT THE TYPE COLUMN SHOWS WHEN THERE IS NO FORMAT.
   *
   * It printed `fmt?0` for every row of `/usr/bin` — `fmtName(0)` for a file whose extension
   * nothing maps, which is every program in the system. A column that reads `fmt?0` thirty-two
   * times is a column carrying no information, and it was the first thing visible once the names
   * were legible.
   *
   * One `lstat` per row buys it. That is 32 extra calls for a directory of 32 things, which is what
   * `ls -l` already costs — and the alternative is a listing that cannot tell a program from a data
   * file, which is the distinction a reader of `/usr/bin` most wants.
   *
   * M19: AND THE CALL IS PAID FOR A DIRECTORY TOO, which is what a Date modified column costs. It
   * sat inside `if (!isDir)`, so a folder had no modification time at all and the column would have
   * had an empty cell on every one of them — a column lying about half its rows. `--no-dir-stat` is
   * that world, kept as a control: the folder DATE cells go empty and nothing else moves, so the
   * clause it breaks is exactly the one that says the call happens.
   *
   * A REFUSED STAT LEAVES THE ROW, with its cells empty. A listing that dropped the rows it could
   * not stat would be a file manager hiding files, which is the defect M14 removed from the other
   * end. `statted` is what `cellOf` reads to tell an empty cell from an unknown one.
   *
   * M23: THE TIME IS MEASURED, which is what A10 asked for and all this slice could answer. A10's
   * fix is a `readdir` that returns the stat beside the dirent, and that is `src/abi.mjs`,
   * `src/kernel/calls.mjs` and `src/kernel/synth.mjs` — three files this slice does not own. What
   * it can do is price the call that would go away: `account.statMs` against `account.stats`.
   */
  const makeRow = (base, name, isDir, { bin = false } = {}) => {
    const format = isDir ? 0 : env.std.formatForPath(name);
    const path = `${base}${name}`;
    let exec = false;
    let size = 0;
    let mtimeMs = 0;
    let statted = false;
    if (!isDir || !noDirStat) {
      account.stats += 1;
      if (isDir) account.dirStats += 1;
      const from = performance.now();
      const st = env.fs.lstat(path);
      account.statMs += performance.now() - from;
      if (typeof st !== "number") {
        statted = true;
        exec = (st.mode & 0o111) !== 0;
        size = Number(st.size);
        // NANOSECONDS INTO MILLISECONDS, which is the unit `Date` takes and the unit the VFS
        // stamped in the first place (`src/kernel/calls.mjs`). A BigInt would also not survive
        // the account's trip out of this process.
        mtimeMs = Number(st.mtimeNs / 1000000n);
      }
    }
    /* M21. WHERE THIS ROW CAME FROM, read by `readlink` of the record beside it — the LOOKUP half
     * of the Bin's join, paid once per row and only in the Bin. `""` is a payload whose origin
     * record is not there: a row a reader can see and drag out of the Bin by hand, and cannot
     * Restore, which `restoreOne` refuses by name rather than guessing a destination. */
    let origin = "";
    if (bin) {
      const target = env.fs.readlink(originRecordOf(path));
      if (typeof target === "string") origin = target;
    }
    return { name, dir: isDir, format, exec, size, mtimeMs, statted, path, origin };
  };

  const buildRows = (path, order = sort) => {
    const entries = env.std.listDir(env, path);
    if (typeof entries === "number") return entries;
    // The directory with exactly one trailing slash, so a child path is `base + name` and the
    // root does not become `//name`.
    const base = path.endsWith("/") ? path : `${path}/`;
    /* M21. THE BIN'S LISTING IS THIS `readdir` WITH THE ORIGIN STORE AS A LOOKUP, and the join runs
     * in exactly that direction (this file's header): the PAYLOAD entries are the rows, and
     * `readlink` is asked once per row for where it came from. An ORIGIN RECORD IS NOT A ROW — it
     * is a symlink carrying a path, it has no bytes, and a reader cannot restore it — so it is
     * filtered out and counted. A record with no payload is counted as STRANDED, which is the
     * half-state an interrupted delete leaves and the one that shows a reader nothing wrong. */
    const bin = dirKey(path) === dirKey(binRoot);
    const present = bin ? new Set(entries.map((e) => e.name)) : null;
    const isRecord = (e) => bin && e.type === DT_LNK && e.name.endsWith(ORIGIN_SUFFIX);
    // SET IN ONE PLACE FOR BOTH ANSWERS, so the count cannot outlive the listing it describes: a
    // window that walked out of the Bin reports no stranded records rather than the last figure.
    account.bin.strandedRecords = bin
      ? entries.filter((e) => isRecord(e)
        && !present.has(e.name.slice(0, -ORIGIN_SUFFIX.length))).length
      : 0;
    account.bin.listing = bin;
    const built = entries
      .filter((e) => e.name !== "." && e.name !== ".." && !isRecord(e))
      .map((e) => makeRow(base, e.name, e.type === DT_DIR, { bin }));
    return sortRows(built, order);
  };

  /**
   * THE LISTING AS IT WAS READ, before any search narrowed it. M23 added it and `rows` kept its
   * meaning, which is the whole design of the filter: `rows` IS WHAT IS DISPLAYED, so the
   * selection, the cursor, the band, the drag, the menu target and every index in the account go on
   * meaning a row a reader can see. A filter that left `rows` whole and kept a separate "visible
   * set" would put an index into one list through a hit test on the other, which is the wrong-file
   * class of defect this program has paid for twice.
   */
  let allRows = [];
  /** The rows, AND THEY ARE STATE SINCE M18: a re-list replaces the whole array rather than opening
   *  a second window, so everything that indexes it — the selection, the press, the cursor — is
   *  reset by `relist` and not by its callers. */
  let rows = buildRows(dir);
  /* A BIN THAT IS NOT THERE YET IS AN EMPTY BIN, NOT AN ERROR. The Bin directory is created by the
   * first delete, so on a fresh volume it does not exist — and `--bin` is how the desktop's Recycle
   * Bin icon launches this program, so refusing here is a double-click that opens nothing.
   * Measured: `bench/shell-landing/firefox-landing.py` reported `Recycle Bin 4->4 NOTHING` while
   * every other icon opened, and no Chrome check drove that icon at all, so it was unmeasured
   * rather than green. A reader who has deleted nothing still gets a window that says so. */
  if (typeof rows === "number" && openBin) rows = [];
  if (typeof rows === "number") {
    return {
      exit: env.std.complainErrno(env, NAME, dir, rows), program: NAME, errno: -rows,
    };
  }
  allRows = rows;
  account.rows = reportRows();
  /* AN EMPTY DIRECTORY ON THE COMMAND LINE IS STILL A REFUSAL, AND AN EMPTY ONE NAVIGATED INTO IS
   * NOT. The difference is whether there is a window to say it in: here there is none, so the only
   * honest place for the message is stdout and the only honest outcome is an exit. `relist` keeps
   * the window and draws a header reading `0 items`, which is where a reader meets the same fact. */
  /* AND `--bin` IS THE CASE WHERE THERE IS SOMETHING TO SAY IT IN, which is the distinction the
   * note above draws rather than an exception to it. A typed operand is a question and stdout is
   * where its answer belongs; the Recycle Bin is a PLACE a reader clicked, and an empty one is its
   * ordinary state rather than a mistake. So the window opens and `relist`'s `0 items` header is
   * where the same fact is met — the behaviour the note already describes for a navigated-into
   * empty directory. */
  if (rows.length === 0 && !openBin) {
    return {
      exit: env.std.complain(env, NAME, dir, "this directory is empty"), program: NAME,
      ...account,
    };
  }

  /* ---- THE LIVE LAYOUT, WHICH IS WHAT M16 ADDED -------------------------------------------- */

  /** Surface pixels per CSS pixel. `1` until the first `WEV_CLIENT`, and the display's ratio after
   *  it: `std.resurface` asks for exactly the client box in device px, so the surface and the
   *  display share a unit and ONE factor converts both directions. A program that asked for some
   *  other backing-store size would not have that coincidence and could not use `cssPointAt`. */
  let S = 1;
  /** The client area, CSS px. The opening guess until the first `WEV_CLIENT` measures it. */
  let clientW = START_W;
  let clientH = 0;
  /** The surface the kernel granted, DEVICE px. Kept beside `S` because the clip rect is checked
   *  against it before it is sent: `win_draw` refuses a WHOLE batch whose `DL_CLIP` starts outside
   *  the surface, so a viewport the window has no room for must not be named at all. */
  let surfW = 0;
  let surfH = 0;
  /** The press that might become a drag or a band, and whether it has become a drag. Declared here
   *  because a resize re-reads them. */
  let press = null;
  let dragging = false;
  /** THE ROW A LIVE DRAG PUBLISHED, or null — `{name, path}`. It outlives the gesture's samples
   *  because the RECEIPT is what acts on it: a MOVE is completed by the source when the kernel
   *  reports the effect, which is several events after the press that chose the row. */
  let dragged = null;
  /** THE LAST DROP THIS WINDOW TOOK, or null — `{into, landed}`. Only the RECEIPT reads it, and only
   *  for the one case where the source and the target are this same window: whether the original may
   *  go depends on whether the landing happened and where. */
  let lastDrop = null;
  /**
   * THE SELECTION, AS A SET OF ROW INDICES, AND ITS ANCHOR.
   *
   * A SET because M19's rules need more than one row and an anchor-based range cannot be expressed
   * with a single index. INDICES rather than names because `rows` IS the layout — the sort reorders
   * the array itself — so an index is a position a reader can point at, and a Shift range over
   * indices is a range in layout order by construction.
   *
   * THE ANCHOR IS WHERE A RANGE STARTS, and it is moved by a plain press AND by a Ctrl+press. The
   * second half is the rule that is easy to miss: Ctrl+clicking three rows and then Shift+clicking
   * a fourth must range from the third, not from the first, or the reader's last gesture is not
   * where the next one starts from.
   */
  let sel = new Set();
  let anchor = -1;
  /** THE LIT ROW — the hover, `-1` for none. Not the selection and not the cursor: a reader moving
   *  the pointer across a list has chosen nothing, and a hover that selected would make every pass
   *  of the hand a choice. */
  let lit = -1;
  /** THE RUBBER BAND, or null. ITS CORNERS ARE IN CONTENT COORDINATES — `y` plus the scroll offset
   *  — so a band that is open while the list scrolls keeps hold of the rows it was drawn over
   *  rather than sliding across new ones. The drawing converts back by subtracting the offset, in
   *  the one place every other rectangle is converted. */
  let band = null;
  /** THE KEYBOARD CURSOR, and `-1` is "nothing is focused" rather than "row 0". It is NOT the
   *  selection: a press on the header clears the selection, and clearing the reader's place in the
   *  list with it would make the arrow keys start over every time the pointer missed. */
  let focus = -1;
  const setFocus = (i) => { focus = i; account.focus = i; };

  /** Publish the selection. ASCENDING, because a set has no order and a check asserting a Shift
   *  range needs one — and the anchor beside it, because a Ctrl+press that moved the anchor and
   *  toggled nothing else is invisible in the set alone. */
  const reportSelection = () => {
    account.selected = [...sel].sort((a, b) => a - b);
    account.anchor = anchor;
  };
  /** Replace the selection with one row, or with nothing at `-1`. */
  const selectOnly = (i) => {
    sel = i >= 0 ? new Set([i]) : new Set();
    anchor = i;
    reportSelection();
  };

  /* ---- M20's STATE: THE OPEN MENU, THE RENAME EDIT AND THIS PROCESS'S CLIPBOARD INTENT ----- */

  /** THE MENU THE KERNEL IS HOLDING FOR THIS WINDOW, or null: `{ rows, target }` where `rows` are
   *  this program's own records in the order they were published and `target` is the row the menu
   *  was raised on (`-1` for empty space). A `WEV_ITEM` carries an index into `rows` and nothing
   *  else, so this array is the only route from that index back to a verb — and it is cleared the
   *  moment an activation or a dismissal arrives, because the kernel closes the menu on either. */
  let menu = null;
  /** THE RENAME EDIT, or null: `{ row, was, draft }`. `was` is the name on screen when F2 was
   *  pressed and is what a commit compares against, so a reader who retypes the same name pays no
   *  `rename` at all. `row` is an INDEX and the edit is cancelled by anything that reorders the
   *  list, for `relist`'s reason: an index into a listing that is gone renames the wrong file. */
  let editing = null;
  /** WHAT THIS PROCESS PUT ON THE CLIPBOARD, and the INTENT it put it there with. The intent lives
   *  here and nowhere else because the published object is sealed and the record carries no field
   *  for it (this file's header): a Cut pasted in a DIFFERENT `files` window is a copy, stated. */
  let clip = null;

  /**
   * FORGET AN OPEN MENU, because the list its rows index is about to be replaced.
   *
   * THE KERNEL'S SIDE IS NOT CLOSED BY THIS, and it must not be: there is no "withdraw a menu"
   * call, and inventing one would be an ABI change for a case the ABI already handles — a pick
   * against a menu this program has forgotten arrives, finds no record, and is REFUSED BY NAME.
   * The alternative is acting on `open.target` as an index into a listing that has gone, which is
   * the wrong-file class of defect `relist` resets everything else to avoid.
   */
  const forgetMenu = () => {
    menu = null;
    account.menuRows = [];
    account.menuTarget = -1;
    account.menuInSurfaceAt = null;
  };

  /* ---- THE SCROLL OFFSET, WHICH IS WHAT M17 ADDED ------------------------------------------ */

  /** How far down the list the viewport sits, CSS px. FRACTIONAL ON PURPOSE: a notch is surface px
   *  divided by `S`, so at dpr 2 an odd delta is a half CSS pixel, and rounding each notch would
   *  lose a pixel per notch over a long gesture. `px` rounds at the display boundary, which is the
   *  one place a fraction may not survive. */
  let scroll = 0;

  /** The far clamp for the live row count, client box AND VIEW MODE. `scrollMaxFor` calls
   *  `FILES_METRICS.scrollMax` in the `rows` flow, so the Details clamp is the exported one. */
  const maxScroll = () => scrollMaxFor(view, rows.length, clientW, clientH);

  /**
   * Move the offset by `dCss` and CLAMP IT AT BOTH ENDS, counting each end separately.
   *
   * BOTH EDGES ARE REAL AND BOTH ARE COUNTED, because both are asserted and a single "it clamped"
   * passes for a list that only ever reached one of them. The top clamp is 0 — a list does not
   * scroll above its first row — and the bottom is `scrollMax`, which puts the last row's bottom on
   * the viewport's rather than leaving the content to run off the window.
   *
   * THE ASKED-FOR DELTA IS SUMMED WHETHER OR NOT IT LANDED (`dyTotal`), which is what makes "the
   * offset equals the full summed delta" an assertion about COALESCING rather than about clamping:
   * a notch the clamp ate is visible as the difference, and a notch the kernel dropped is not in
   * either number.
   */
  const scrollBy = (dCss) => {
    if (dCss === 0) return false;
    account.dyTotal += dCss;
    const want = scroll + dCss;
    const limit = maxScroll();
    let next = want;
    /* THE COUNT IS OF CLAMPS AND NOT OF MOVES, so a wheel at an end that moves nothing still
     * counts: the clamp is what stopped the delta, and a reader pushing at the top of a list gets
     * one per notch. SAID ONCE PER EDGE, which is the rule the surface refusal in the event loop
     * already follows: a line per notch is a flood, and the count carries the rest. */
    /* `--unclamped-scroll` REMOVES THE END CLAMP, AND ONLY THAT ONE. It is a CONTROL rather than a
     * fixture: the world in which the list scrolls past its last row into blank paper, and nothing
     * refuses. Nothing counts a bottom clamp either, because a clamp that did not happen must not
     * be reported as one — an `account.clamped` that rose while the offset ran past the end would
     * make the program's own report disagree with its behaviour, and the check reads that report.
     *
     * THE TOP CLAMP STAYS, which is the difference between this control and a useless one.
     * `docs/PLAN-SHELL.md` §M17 asks that "the clamp clauses MUST fail alone", and removing BOTH
     * edges cannot deliver that: the page establishes its magnitude clause by scrolling back to
     * the top and measuring a known delta from there, so a list that cannot reach the top loses a
     * clause this control is not about. Measured, not reasoned — with both edges gone the control
     * also turned `and the scroll matched the wheel the page received`, and the harness refused it
     * for moving a clause it claims not to touch. */
    if (unclampedScroll && want > limit) {
      account.scrollMax = limit;
      if (want === scroll) return false;
      scroll = want;
      account.scroll = scroll;
      return true;
    }
    if (want < 0) {
      next = 0;
      account.clamped.top += 1;
      if (account.clamped.top === 1) env.std.say(env, `${NAME}: the list is at the top\n`);
    } else if (want > limit) {
      next = limit;
      account.clamped.bottom += 1;
      if (account.clamped.bottom === 1) {
        env.std.say(env, `${NAME}: the list is at the end, offset ${Math.round(limit)} CSS px\n`);
      }
    }
    account.scrollMax = limit;
    if (next === scroll) return false;
    scroll = next;
    account.scroll = scroll;
    return true;
  };

  /** The rows the viewport shows at the current offset: `[first, last]` inclusive, or `first > last`
   *  for a viewport with no room in it. BOUNDED BY THE VIEWPORT AND NOT BY A CAP, which is what
   *  keeps the op count of a frame the same as the pre-M17 capped list's — a 4,000-entry directory
   *  draws the forty rows a reader can see, not four thousand the clip would throw away. */
  const visible = () => {
    const box = FILES_METRICS.viewBox(clientW, clientH);
    if (box.h <= 0 || box.w <= 0) return { first: 0, last: -1 };
    /* FLOORED TO THE PITCH, which can name a row whose last pixel sits just above the viewport. The
     * clip discards that row and erring this way is how a PARTIALLY visible one is never missed;
     * erring the other way is a blank strip under the header on every fractional offset. */
    if (view.flow === FLOW_ROWS) {
      const first = Math.max(0, Math.floor((scroll + VIEW_TOP - rowTop(0)) / ROW_STRIDE));
      let last = first - 1;
      while (last + 1 < rows.length && rowTop(last + 1, scroll) < box.y + box.h) last += 1;
      return { first, last };
    }
    /* M23. A GRID'S RANGE IS A RANGE OF LANES, AND IT IS CONTIGUOUS IN INDEX ORDER BY CONSTRUCTION.
     * A lane is filled before the layout wraps, so the items a viewport shows are
     * `[firstRun * lanes, (lastRun + 1) * lanes - 1]` — one interval, which is what lets `paint`
     * stay a single loop and `account.firstRow` keep meaning what it meant. A layout whose visible
     * set was not an interval would need a second drawing path and a second way to be wrong. */
    const { lanes, pitchW, pitchH } = lanesOf(view, box);
    const pitch = axisOf(view) === "x" ? pitchW : pitchH;
    const room = axisOf(view) === "x" ? box.w : box.h;
    const firstRun = Math.max(0, Math.floor((scroll - PAD) / pitch));
    const runs = Math.max(1, Math.ceil((room + (scroll - PAD - firstRun * pitch)) / pitch));
    // NOT CLAMPED UP TO THE LAST ITEM: a `first` past the end must leave `first > last`, which is
    // the empty range every caller already handles, and not name the final cell.
    return {
      first: firstRun * lanes,
      last: Math.min(rows.length - 1, (firstRun + runs) * lanes - 1),
    };
  };

  /* THE OPENING HEIGHT FITS WHAT IT CAN AND SCROLLS TO THE REST, which is the one line M17 changed
   * here: the window used to open at the height of the rows it would DRAW, with a slot for the
   * "+N more" line. `START_ROWS` is a ceiling on the opening HEIGHT and no longer on the list. */
  /* M23: AND THE OPENING HEIGHT IS THE DETAILS VIEW'S WHATEVER MODE `--view` NAMED. `clientHeightFor`
   * is `rowsThatFit`'s declared inverse for the `rows` flow and there is no inverse for a grid — how
   * tall a grid of n cells is depends on how WIDE the window is, and the width is not known until
   * the first `WEV_CLIENT`. So a window opened in Large icons opens at the height the same directory
   * would need in Details and then scrolls, which is honest: the opening size is a guess either way
   * (see `win.create` below) and the measurement that corrects it is one event away. */
  clientH = clientHeightFor(Math.min(rows.length, START_ROWS));
  account.scrollMax = maxScroll();
  account.maxRows = pageStepFor(view, rows.length, clientW, clientH);
  account.lanes = lanesOf(view, FILES_METRICS.viewBox(clientW, clientH)).lanes;

  const made = env.win.create({
    // THE FRAME IS THE CLIENT BOX PLUS A GUESS AT THE CHROME, and the guess is all it may be: what
    // the chrome costs is the page's to measure, and `WIN_CAP_H`/`WIN_INSET` describe no element
    // on four of the five hosts that render a surface (PRD §2). The first `WEV_CLIENT` corrects
    // whatever this opened at.
    title: `${NAME} — ${dir}`, w: clientW + 20, h: clientH + 40,
    // CLEAR OF THE DESKTOP'S ICON COLUMN: see `WIN_ORIGIN_X` in src/libos/std.mjs.
    x: env.std.WIN_ORIGIN_X, y: env.std.WIN_ORIGIN_Y,
  });
  if (typeof made === "number") {
    return { exit: 2, ...account, why: `win_create: ${env.std.errnoName(made)}`, errno: -made };
  }
  account.win = made.win;
  account.fd = made.fd;
  /* THE OPENING SURFACE IS ASKED FOR IN CSS NUMBERS, AND IT IS THE ONE REQUEST THAT CANNOT BE IN
   * DEVICE PIXELS: `WEV_CLIENT` is a program's only route to the ratio (PRD §2) and it has not
   * arrived yet. So the first frame is drawn at `S = 1` and CSS-stretched — the pre-M16 picture,
   * for as long as it takes one geometry report to cross — and then the client event refits it.
   *
   * DRAWN AT ONCE RATHER THAN WAITING FOR THE MEASUREMENT, because a host that reports no client
   * box would otherwise leave a reader looking at an empty window for ever, and a program must not
   * depend on an event to show anything at all. */
  const surf = env.win.surface(made.fd, Math.round(clientW), Math.round(clientH));
  if (surf < 0) {
    env.win.destroy(made.fd);
    return { exit: 3, ...account, why: `win_surface: ${env.std.errnoName(surf)}`, errno: -surf };
  }
  surfW = Math.round(clientW);
  surfH = Math.round(clientH);
  account.surface = { w: surfW, h: surfH };
  account.client = { w: clientW, h: clientH };

  /** The row under a CSS-px `y`, or -1. `FILES_METRICS.rowAt` is the arithmetic — the declared
   *  inverse of the `rowTop` that `paint` draws with, at the SAME offset — and the BOUND is here
   *  because both the row count and the viewport are live.
   *
   *  A PRESS OUTSIDE THE VIEWPORT FINDS NOTHING. The clip is what makes that necessary: a row the
   *  reader cannot see because it was clipped away is still at a `y` the arithmetic maps, and
   *  selecting it would be a press landing on a row nobody can see — the hit test and the clip must
   *  bound the same rectangle or one of them is lying. */
  const rowUnder = (yCss, xCss = PAD) => {
    if (!inViewport(yCss)) return -1;
    /* M23. `itemAtPoint` CALLS `FILES_METRICS.rowAt` IN THE `rows` FLOW, so the Details hit test is
     * still the exported inverse and still ignores `x` — a press anywhere across a row finds it.
     * In a grid the `x` decides which lane, so the parameter is real; it defaults to `PAD` so the
     * callers that have only a `y` (the drop, which carries one point) keep working in Details and
     * find the first lane in a grid, which is the only lane a single-coordinate caller can mean. */
    const i = itemAtPoint(view, xCss, yCss, scroll, clientW, clientH);
    return i >= 0 && i < rows.length ? i : -1;
  };

  /** WHETHER A CSS-PX `y` IS INSIDE THE VIEWPORT AT ALL — the HEADER, the status strip and the gap
   *  between two rows answer differently to `rowUnder`, which cannot tell "above the list" from
   *  "between two rows". A rubber band may start in either of the second two and in neither of the
   *  first, so the two questions are separate functions rather than one return value. */
  const inViewport = (yCss) => {
    const box = FILES_METRICS.viewBox(clientW, clientH);
    return yCss >= box.y && yCss < box.y + box.h;
  };

  /**
   * ONE CORNER OF A RUBBER BAND, from a CSS-px point — the START corner, or the MOVING one when
   * `moving` is set.
   *
   * THE SCROLL OFFSET GOES ON THE MODE'S OWN AXIS AND ON NO OTHER. A band's corners are CONTENT
   * coordinates along the axis the list scrolls, so that a band held open while the list moves
   * keeps the items it was drawn over (M19's rule); on the other axis nothing scrolls, so adding
   * the offset there would slide the rectangle across lanes the reader never crossed. In Details
   * that is `y + scroll`, which is exactly the arithmetic that was written inline here before.
   */
  /* ---- M23: THE ADDRESS STRIP'S THREE STATES ----------------------------------------------- */

  /**
   * WHAT THE ADDRESS STRIP IS DOING: `"trail"`, `"path"` or `"search"` — and only ONE of the three,
   * which is what makes the keyboard unambiguous. R28's editable path and R31's search field are two
   * text fields in one strip; a reader typing has to be typing into one of them, and a design where
   * both could be open at once is a design where a keystroke has two destinations.
   */
  let strip = "trail";
  /** The draft in whichever field is open, and `""` when none is. ONE buffer for both, because only
   *  one field is ever open — two buffers would be two things to reset and one of them would be
   *  missed. `stripWas` is what the field opened holding, so Esc can put it back. */
  let stripDraft = "";
  let stripWas = "";
  /** THE QUERY THE LISTING IS NARROWED BY, `""` for none. It OUTLIVES the field being open: a reader
   *  who types a query and presses Enter is still looking at the filtered list, which is what every
   *  search box does. Cleared by Esc in the field and by a navigation. */
  let query = "";
  /** THE WALK IN FLIGHT, or null — `{ stack, seen, dirs, found, from, deep }`. R31's chunked search:
   *  a resumable depth-first walk whose state is this object, stepped between polls so the window
   *  goes on servicing input (R31's own requirement). `null` means the search is the free one — a
   *  filter over the listing in hand, which costs no syscall at all. */
  let walk = null;
  /** THE QUERY A COMPLETED WALK PRODUCED THE LISTING WITH, `""` for none.
   *
   *  IT IS WHAT STOPS ESC UNDOING A SEARCH IT CANNOT UNDO. `closeStrip` puts the query back to what
   *  the field opened holding, which is right while the listing is still this directory's — the
   *  filter re-runs and the reader gets their folder back. After a WALK the listing is no longer
   *  this directory's: `allRows` holds matches from all over the tree, and clearing the query would
   *  leave a listing of files from nowhere in particular with nothing on screen to say why. So the
   *  query stays, because it is the only description that listing has. Cleared by `relist`, which
   *  is where the listing becomes a directory's again. */
  let walked = "";

  /**
   * NARROW `allRows` BY `query` AND COMMIT IT AS `rows`. Answers nothing; the caller repaints.
   *
   * THE SELECTION AND THE CURSOR ARE DROPPED, because both are indices into the list being replaced
   * — which is `relist`'s own rule and the same reason. A reader who filters and finds their
   * selection still highlighted would be looking at a highlight on whatever row took that index.
   */
  const applyFilter = () => {
    rows = query === "" ? allRows : allRows.filter((r) => searchMatch(r.name, query));
    account.rows = reportRows();
    account.query = query;
    account.matched = rows.length;
    account.listed = allRows.length;
    sel = new Set();
    anchor = -1;
    reportSelection();
    setFocus(-1);
    setLit(-1);
    band = null;
    press = null;
    dragging = false;
    const limit = maxScroll();
    if (scroll > limit && !unclampedScroll) scroll = limit;
    account.scroll = scroll;
    account.scrollMax = limit;
  };

  /** COMMIT A FRESHLY BUILT LISTING: it becomes `allRows`, and the filter decides `rows`. THE ONE
   *  PLACE a listing enters this program after startup, so a re-read cannot forget the query a
   *  reader has typed and show them the whole directory again. */
  const commitRows = (built) => {
    allRows = built;
    rows = query === "" ? built : built.filter((r) => searchMatch(r.name, query));
    account.query = query;
    account.matched = rows.length;
    account.listed = allRows.length;
  };

  const bandCorner = (at, moving = false) => {
    const onX = axisOf(view) === "x";
    return moving
      ? { x1: at.x + (onX ? scroll : 0), y1: at.y + (onX ? 0 : scroll) }
      : { x0: at.x + (onX ? scroll : 0), y0: at.y + (onX ? 0 : scroll) };
  };

  /** Light row `i`, or nothing at `-1`. Answers whether it CHANGED, so a stream of hovers across
   *  one row costs one repaint and not one per sample. */
  const setLit = (i) => {
    if (i === lit) return false;
    lit = i;
    account.lit = i;
    return true;
  };

  /* ---- M23: THE THUMBNAIL CACHE, AND THE ONE PLACE A DECODE HAPPENS ------------------------ */

  /**
   * path -> `{ key, fd, w, h, bytes, why, usedAt }`, one entry per picture this program is holding.
   *
   * `fd` IS THE WHOLE POINT: a `DL_BLIT` names a data-object fd and the payload is KERNEL-owned and
   * refcounted (constraints 240, 241), so the picture outlives nothing of this program's except the
   * descriptor — and closing the fd is what returns the bytes to the budget. A process still holds
   * only integers (constraint 15).
   *
   * `key` CARRIES THE DEVICE EXTENT AND THE FILE'S OWN STAMP, which is what makes the entry
   * invalidate rather than go stale: a dpr change needs a new payload at a new size (`thumbFit`),
   * and a file rewritten under the window needs a new picture of new bytes. A cache keyed on the
   * path alone is the same defect as `--no-resurface`, one layer down.
   *
   * `why` IS SET ON AN ENTRY WITH NO `fd`: the row fell back to its type icon, and this is the
   * reason — kept so one broken PNG costs one decode and not one per frame.
   */
  const thumbs = new Map();
  /** Payload bytes this program is holding, summed. Reported, so a reader can see what a view mode
   *  costs the kernel's data-object budget. */
  let thumbBytes = 0;
  /**
   * THE SQUARE A THUMBNAIL IS FITTED INTO, CSS px — the current mode's icon box, or `0` for a mode
   * that has no thumbnails at all.
   *
   * `0` IS R26'S SCOPE AND IT IS LOAD-BEARING TWICE OVER. The PRD scopes thumbnails to "Medium
   * icons and larger", so Details, Small icons and List show the type icon — which is Windows' own
   * rule, and which also means a window in the DEFAULT mode creates no data object. That second
   * consequence is not incidental: a `files` window holding live payloads raises the kernel's global
   * `DataMgr.bytes`, and `www/m10.html` reads that global sum as its proxy for "the drop's payload
   * was released". A thumbnail in Details would turn that clause red over a program behaving
   * correctly — see this file's report to the lead.
   */
  const thumbCellCss = () => (view.thumbs ? view.icon : 0);
  /** A monotonic stamp, bumped once per fill pass, so the eviction order is "least recently wanted
   *  by the viewport" rather than insertion order. Not a clock: the pass number is the only ordering
   *  that matters and constraint 72's argument against reading one applies here too. */
  let thumbPass = 0;

  /** Close one entry's object and give its bytes back. Idempotent: an entry that fell back holds no
   *  fd, and dropping it twice must not close a descriptor this program no longer owns. */
  const dropThumb = (path) => {
    const held = thumbs.get(path);
    if (!held) return;
    if (held.fd > 0) {
      env.fs.close(held.fd);
      thumbBytes -= held.bytes;
      account.thumbs.released += 1;
    }
    thumbs.delete(path);
  };

  /**
   * Every picture, released. The listing is about to be replaced, so every path in the cache names
   * a file this window is no longer showing — and a cache that outlived its directory would blit
   * the previous folder's image beside a name from this one.
   *
   * IT TOUCHES NO REPORT FIELD, WHICH IS A FIX AND NOT A STYLE. It set `ready`, `bytes` and `rows`
   * to zero, and the exit path calls it — so the account a check reads on the way out said this
   * window had never had a thumbnail, which is exactly the clause R26 owes. A release is not a
   * measurement: `released` counts what went, and `ready` goes on describing the last fill pass.
   */
  const dropAllThumbs = () => {
    for (const path of [...thumbs.keys()]) dropThumb(path);
  };

  /** The entry to blit for `row`, or null. A cache read and nothing else: `paint` must not decode,
   *  must not allocate and must not evict — a repaint that could invalidate an fd it is already
   *  naming in the batch it is building is a `win_draw` refused WHOLE. */
  const thumbFor = (row) => {
    const held = thumbs.get(row.path);
    return held && held.fd > 0 ? held : null;
  };

  /** Whether `row` is a candidate at all: a file, of a format `THUMBNAILED` names, small enough to
   *  read whole. A directory is not a candidate — there are no bytes — and neither is a row whose
   *  `lstat` was refused, because the size that bounds the read is unknown. */
  const thumbnailable = (row) => !row.dir && !!THUMBNAILED[row.format]
    && row.statted && Number(row.size) > 0 && Number(row.size) <= THUMB_SOURCE_MAX;

  /** Why `row` cannot have one, or `""` — the reason a fallback is STATED rather than blank. Only
   *  the two cases `thumbnailable` rejects that a reader could be surprised by: a format nothing
   *  decodes is not one of them, because the row never asked. */
  const thumbBar = (row) => {
    if (!row.statted) return "its lstat was refused, so there is no size to bound a read by";
    if (Number(row.size) > THUMB_SOURCE_MAX) {
      return `${row.size} bytes is past the ${THUMB_SOURCE_MAX}-byte read ceiling`;
    }
    return "";
  };

  /**
   * AN `ImageBitmap` OF `row`'S BYTES, or `{ why }`. THE ONLY `await` IN THIS PROGRAM, and the whole
   * design rests on where it is: `bench/m23-blit/` measured that a decode promise settles inside a
   * real process in a stripped realm — but NOT while the process is parked in a syscall and NOT
   * while it spins, only in an AWAITED turn, and a cold one needs seven macrotask turns. So a
   * decode MUST NOT be folded into a syscall reply (constraint 219's shape, for a promise) and this
   * function is called between polls and never from `paint`.
   *
   * TWO ROUTES, FROM `THUMBNAILED`. A `.rgba` is already an `encodeBitmap` payload, so its header is
   * checked with `decodeBitmap` — the same function the kernel validates a blit with (constraint
   * 293's rule) — and its pixels go through `ImageData`, which needs no decoder at all. A `.png`
   * goes through the platform's, which is what makes the realm measurement load-bearing.
   */
  const bitmapFor = async (row) => {
    const bytes = env.std.readFileBytes(env, row.path, THUMB_SOURCE_MAX);
    if (typeof bytes === "number") {
      return { why: `read: ${env.std.errnoName(bytes)}` };
    }
    try {
      if (row.format === DOBJ_BITMAP) {
        const raw = decodeBitmap(bytes);
        if (!raw) return { why: "the bytes do not match their own bitmap header" };
        // A COPY AND NOT THE SUBARRAY: `ImageData` wants a `Uint8ClampedArray` of exactly w*h*4,
        // and a view onto a longer buffer is not one.
        const data = new ImageData(new Uint8ClampedArray(raw.pixels), raw.w, raw.h);
        return { bmp: await createImageBitmap(data) };
      }
      return { bmp: await createImageBitmap(new Blob([bytes])) };
    } catch (error) {
      /* A REJECTION IS THE ERROR PATH R26 OWES, AND IT IS NOT A FAULT. `createImageBitmap` rejects
       * on corrupt bytes and on a format the platform will not take, which is precisely the case
       * "a PNG falls back to its type icon" was written for — so it is caught, named, and the row
       * keeps the icon it already had. An uncaught rejection here would kill the window. */
      return { why: `decode: ${(error && error.message) || String(error)}` };
    }
  };

  /**
   * ONE PICTURE, AS A LIVE DATA OBJECT. Answers the entry, or `{ why }`.
   *
   * THE READBACK IS THE SECOND PLATFORM CALL AND IT IS NOT OPTIONAL. An `ImageBitmap` is a handle,
   * and a process holds only integers (constraint 15) — there is no transfer out — so the only
   * route from a decode to `DL_BLIT` is the pixels as bytes, through `OffscreenCanvas` +
   * `getImageData`. `bench/m23-blit/` measured the round trip BYTE-EXACT against this repo's own
   * `/usr/share/logo.rgba` over every fully opaque pixel, in both engines.
   *
   * `drawImage` SCALES AND `putImageData` DOES NOT, which is why the fit happens here: the scratch
   * canvas is the payload's own size and the bitmap is drawn INTO it, so what comes back out is
   * already the extent `DL_BLIT` will draw.
   */
  const makeThumb = async (row, cellCss) => {
    const got = await bitmapFor(row);
    if (!got.bmp) return got;
    const bmp = got.bmp;
    const fit = thumbFit(bmp.width, bmp.height, cellCss, S);
    let payload = null;
    try {
      const canvas = new OffscreenCanvas(fit.w, fit.h);
      const ctx = canvas.getContext("2d");
      if (!ctx) return { why: "OffscreenCanvas.getContext('2d') returned null" };
      ctx.drawImage(bmp, 0, 0, bmp.width, bmp.height, 0, 0, fit.w, fit.h);
      payload = encodeBitmap(fit.w, fit.h, ctx.getImageData(0, 0, fit.w, fit.h).data);
    } catch (error) {
      return { why: `readback: ${(error && error.message) || String(error)}` };
    } finally {
      // THE HANDLE IS RELEASED AS SOON AS ITS PIXELS ARE OUT. A process cannot be asked to hold one
      // across a park, and an undisposed bitmap is renderer memory the process table cannot see.
      if (typeof bmp.close === "function") bmp.close();
    }
    if (fit.clamped) account.thumbs.clamped += 1;
    const object = env.data.create([DOBJ_BITMAP]);
    if (typeof object === "number") {
      return { why: `dataobj_create: ${env.std.errnoName(object)}` };
    }
    const granted = fmtsOf(object.offer);
    if (!granted.includes(DOBJ_BITMAP)) {
      env.fs.close(object.fd);
      return { why: `the kernel granted only ${granted.map(fmtName).join(", ")}` };
    }
    const set = env.data.set(object.fd, DOBJ_BITMAP, payload);
    if (set < 0) {
      // THE FD GOES WITH THE REFUSAL. `dataobj_set` already undoes a partial write (`src/libos/
      // syscall.mjs`), so what is left is a descriptor against `DOBJ_CAP` and nothing else.
      env.fs.close(object.fd);
      return { why: `dataobj_set: ${env.std.errnoName(set)}` };
    }
    return { fd: object.fd, w: fit.w, h: fit.h, bytes: payload.length };
  };

  /**
   * DECODE WHAT THE VIEWPORT WANTS, AND RELEASE WHAT IT DOES NOT. Answers whether the cache changed,
   * which is whether a repaint is owed.
   *
   * THE WANTED SET IS THE VISIBLE ROWS AND NOTHING MORE. A directory of four thousand images is
   * forty decodes, which is the same argument `visible` makes for the drawing: the rows a reader can
   * see are the rows that cost anything.
   *
   * EVICTION IS BY PASS NUMBER AND ONLY AGAINST A CEILING. `THUMB_CAP` is an ABI limit
   * (`DOBJ_CAP`), so the cache may hold more than one screenful but never more than that — and a
   * viewport wanting more than the cap leaves the remainder on its type icon and COUNTS it, because
   * a view that silently showed 28 pictures and 12 icons would read as 12 broken files.
   *
   * ONE DECODE PER CALL IS NOT THE RULE. A pass decodes everything the viewport is missing, because
   * the alternative is one picture per `POLL_MS` — twenty-eight tiles would take five and a half
   * seconds to appear, and each decode is 0.3 ms plus a few macrotask turns
   * (`bench/m23-blit/results-headless.json`). Input is not starved by it: the loop polls after this
   * returns, and a pass is bounded by the viewport.
   */
  const fillThumbs = async () => {
    if (noThumbs) {
      /* `wanted` IS STILL COUNTED, which is what makes the control's discriminator real. The
       * header says "`wanted` stays where it was and `decoded` goes to 0, which is what tells this
       * world apart from a directory with nothing to decode" — and the first spelling returned
       * before counting, so `wanted` was 0 and the two worlds were identical in the account. */
      const seen = visible();
      let candidates = 0;
      for (let i = seen.first; i <= seen.last && i < rows.length; i += 1) {
        if (!rows[i].dir && THUMBNAILED[rows[i].format]) candidates += 1;
      }
      account.thumbs.wanted = candidates;
      account.thumbs.why = "--no-thumbs";
      return false;
    }
    const cellCss = thumbCellCss();
    if (cellCss === 0) {
      /* THE MODE HAS NO PICTURES, SO EVERY ONE IN HAND IS RELEASED. A reader who steps from Large
       * icons down to Details must not leave twenty-eight live payloads behind them: the cache
       * would be unreachable — no mode wants it — and it would hold `DOBJ_CAP` slots the next Copy
       * needs. `wanted` goes to 0 because nothing is wanted, which is what tells this state apart
       * from `--no-thumbs` (where `wanted` stands and `decoded` is 0). */
      if (thumbs.size > 0) {
        dropAllThumbs();
        account.thumbs.ready = 0;
        account.thumbs.bytes = thumbBytes;
        account.thumbs.rows = [];
        account.thumbs.wanted = 0;
        account.thumbs.why = `${view.label} draws type icons`;
        return true;
      }
      account.thumbs.wanted = 0;
      account.thumbs.why = `${view.label} draws type icons`;
      return false;
    }
    thumbPass += 1;
    const passFrom = performance.now();
    const { first, last } = visible();
    let changed = false;
    let capped = 0;
    let fellBack = 0;
    let wanted = 0;
    const live = new Set();
    for (let i = first; i <= last && i < rows.length; i += 1) {
      const row = rows[i];
      if (!thumbnailable(row)) {
        // A ROW WITH NOTHING TO DECODE IS NOT A FALLBACK, with one exception: a candidate format
        // barred by its size or a refused stat IS one, and is said rather than left blank.
        if (!row.dir && THUMBNAILED[row.format]) {
          const bar = thumbBar(row);
          if (bar) {
            wanted += 1;
            fellBack += 1;
            if (!thumbs.has(row.path)) {
              thumbs.set(row.path, { key: "", fd: 0, w: 0, h: 0, bytes: 0, why: bar, usedAt: 0 });
              env.std.say(env, `${NAME}: ${row.name}: no thumbnail — ${bar}\n`);
            }
          }
        }
        continue;
      }
      wanted += 1;
      live.add(row.path);
      /* THE KEY IS THE CONTRACT WITH THE CACHE: the cell, the ratio and the file's own stamp and
       * length. A dpr change, a resize into another view mode and a rewritten file each produce a
       * different key, and a different key is a different picture. */
      const key = `${cellCss}@${S}:${row.mtimeMs}:${row.size}`;
      const held = thumbs.get(row.path);
      if (held && held.key === key) {
        held.usedAt = thumbPass;
        /* A CACHED FAILURE IS STILL A FALLBACK, AND COUNTING IT ONLY ON THE PASS THAT TRIED WAS
         * THE DEFECT. `fellBack` is a per-pass figure — it says how many of the rows a reader can
         * see now are on their type icon — and a refused decode is cached WITH its key, so the
         * second pass over the same viewport took this fast path and reported 0. By exit, R26's
         * `ready` against `fellBack` said no row had ever fallen back. The cache stops the DECODE
         * being repeated, not the statement. */
        if (held.fd === 0) fellBack += 1;
        continue;
      }
      if (held) dropThumb(row.path);
      if (thumbs.size - countFallbacks() >= THUMB_CAP && !evictOne(live)) {
        // NO ROOM AND NOTHING TO TAKE IT FROM: every live object is wanted by this same viewport.
        capped += 1;
        continue;
      }
      const made2 = await makeThumb(row, cellCss);
      changed = true;
      if (!made2.fd) {
        fellBack += 1;
        thumbs.set(row.path, { key, fd: 0, w: 0, h: 0, bytes: 0, why: made2.why, usedAt: thumbPass });
        env.std.say(env, `${NAME}: ${row.name}: no thumbnail — ${made2.why}\n`);
        continue;
      }
      thumbs.set(row.path, { key, ...made2, why: "", usedAt: thumbPass });
      if (account.thumbs.made.length < THUMB_MADE_CAP) {
        account.thumbs.made.push({
          path: row.path, w: made2.w, h: made2.h, bytes: made2.bytes, cell: cellCss, scale: S,
        });
      } else {
        account.thumbs.madeCapped += 1;
      }
      thumbBytes += made2.bytes;
      if (thumbBytes > account.thumbs.peakBytes) account.thumbs.peakBytes = thumbBytes;
      account.thumbs.decoded += 1;
    }
    account.thumbs.wanted = wanted;
    account.thumbs.capped = capped;
    account.thumbs.fellBack = fellBack;
    account.thumbs.bytes = thumbBytes;
    account.thumbs.ready = [...thumbs.values()].filter((t) => t.fd > 0).length;
    account.thumbs.rows = [...thumbs.entries()]
      .map(([path, t]) => ({ path, w: t.w, h: t.h, bytes: t.bytes, why: t.why }));
    account.thumbs.why = capped > 0
      ? `${capped} row(s) past the ${THUMB_CAP}-object cap`
      : (fellBack > 0 ? "see thumbs.rows" : "");
    /* SUMMED OVER EVERY PASS AND ONLY WHEN ONE DECODED. A pass that found the cache warm costs a
     * `visible()` and a map walk, and folding those in would hide what a decode really costs behind
     * however many times the loop turned. */
    if (changed) account.thumbs.decodeMs += performance.now() - passFrom;
    return changed;
  };

  /** How many cache entries hold no object. A fallback costs no `DOBJ_CAP` slot, so it must not be
   *  counted against the cap — a directory of twenty-eight broken PNGs would otherwise stop the
   *  twenty-ninth good one from ever being decoded. */
  const countFallbacks = () => [...thumbs.values()].filter((t) => t.fd === 0).length;

  /** Release the least recently wanted object that this pass does not want. Answers whether one
   *  went. `live` is the set the current viewport is asking for, so eviction can never take a
   *  picture out from under the frame that is about to be drawn. */
  const evictOne = (live) => {
    let victim = "";
    let oldest = Infinity;
    for (const [path, t] of thumbs) {
      if (t.fd === 0 || live.has(path)) continue;
      if (t.usedAt < oldest) { oldest = t.usedAt; victim = path; }
    }
    if (victim === "") return false;
    dropThumb(victim);
    account.thumbs.evicted += 1;
    return true;
  };

  /* ---- THE ONE CONVERSION: CSS PIXELS INTO SURFACE PIXELS ---------------------------------- */

  /** A CSS-px length as a surface coordinate. THE ONLY MULTIPLICATION BY `S` IN THIS PROGRAM —
   *  everything above is CSS px and everything in a display list is surface px, so this function
   *  is the border between them. A per-constant scaling is how two constants come to disagree. */
  const px = (v) => FILES_METRICS.toSurface(v, S);
  /** A filled rect, converted by its EDGES, so a row band and the header rule above it — which
   *  share a CSS x — land on the same device pixel. `px(x) + px(w)` is a pixel past `px(x + w)`
   *  for some widths: not at dpr 1, 1.5 or 2, where the two forms agree for every width from 200
   *  to 2400 device px, but at 1.75 — a scale Windows offers — they differ, and a 906-device-px
   *  client area is one of the cases. Swept with `node -e`, and that width is why the check for
   *  this is at 1.75 rather than at the reference machine's ratio. */
  const fill = (ops, x, y, w, h, rgba) => ops.push({
    op: DL_FILL_RECT, a0: px(x), a1: px(y), a2: px(x + w) - px(x), a3: px(y + h) - px(y), a4: rgba,
  });
  /** An outline. Its width scales too: a 1 CSS px stroke is 2 device px at dpr 2, which is what
   *  makes it the same hairline a reader sees on the rest of the chrome. */
  const stroke = (ops, x, y, w, h, rgba) => ops.push({
    op: DL_STROKE_RECT, a0: px(x), a1: px(y), a2: px(x + w) - px(x), a3: px(y + h) - px(y),
    a4: rgba, a5: Math.max(1, px(1)),
  });
  /** A text run. `size` IS SURFACE PX (`src/wm/surface.mjs` sets the font from it), so it scales
   *  with everything else — a 12 px label drawn at 12 device px inside a 40-device-px row is the
   *  half-size text a reader reported. */
  const text = (ops, s, { x, y, size, rgba, flags = 0, maxWidth = 0 }) =>
    ops.push(...encodeTextRun(s, {
      x: px(x), y: px(y), size: px(size), rgba, flags, maxWidth: maxWidth ? px(maxWidth) : 0,
    }));
  /**
   * ONE CELL, CLIPPED TO ITS OWN COLUMN BY THE RENDERER.
   *
   * `DLT_ELLIPSIS` plus `a5` is the ABI's answer to "this run may be wider than the room it has",
   * and the limit is handed over rather than applied here: a program cannot measure a string, and a
   * sum of published advances is a strict UPPER bound for a proportional run — so a program that
   * pre-cut would truncate early by up to 8.55% of the string (`advanceWidth` in src/abi.mjs). The
   * renderer measures what it is about to draw and is the only thing that can.
   *
   * THE LIMIT IS THE COLUMN'S WIDTH LESS ONE `PAD`, so two neighbouring cells cannot touch. A
   * right-aligned run's `x` is its right edge, so the width is what bounds it leftwards.
   */
  const cellRun = (ops, box, s, { y, size, rgba, mono = false }) => {
    if (s === "") return;
    text(ops, s, {
      x: box.textX,
      y,
      size,
      rgba,
      flags: DLT_ELLIPSIS | (mono ? DLT_MONO : 0) | (box.right_aligned ? DLT_RIGHT : 0),
      maxWidth: Math.max(1, box.w - PAD),
    });
  };

  /**
   * A FOLDER OR A PAGE, OUT OF RECTANGLES. There is no image op either, so a 16x16 glyph is what
   * `DL_FILL_RECT` can be talked into: a folder is a body with a tab on top, a page is a sheet
   * with a dog-eared corner cut out of it. Drawn in the colour the row's KIND already had, so the
   * amber a reader learned to read as "directory" is still amber (`src/wm/icons.mjs` draws the
   * shell's folder in the same colour).
   */
  const glyph = (ops, row, x, y, colour, cell = GLYPH_W) => {
    const k = cell / GLYPH_W;
    if (row.dir) {
      fill(ops, x, y + 4 * k, cell, 10 * k, colour);
      fill(ops, x, y + 1 * k, 7 * k, 3 * k, colour);
      return;
    }
    fill(ops, x + 2 * k, y + 1 * k, cell - 5 * k, 13 * k, colour);
    // The corner, cut back out in the paper colour: the display list has no path op, so a
    // notch is a fill of the background over a fill of the foreground.
    fill(ops, x + cell - 6 * k, y + 1 * k, 3 * k, 3 * k, PAPER);
  };

  /**
   * M23. A THUMBNAIL, CENTRED IN A `cell`-SQUARE WHOSE TOP-LEFT IS `x`, `y` (CSS px).
   *
   * THE CENTRING IS DONE IN DEVICE PIXELS AND THAT IS NOT FUSSINESS. The payload's extent is device
   * px and `DL_BLIT` carries no destination size, so a CSS-px centre converted by `px` would put a
   * picture of a measured width inside a box of a rounded one — half a device pixel off at every
   * fractional ratio, which is where a letterboxed image shows a seam. `px(x)` and
   * `px(x + cell) - px(x)` are the same two edges `fill` uses, so the plate below and the picture
   * on it share them.
   *
   * ONE OP. A blit is the whole of a picture, against the 2-3 fills a type icon costs and the 256
   * `DL_FILL_RECT`s a 16x16 image would have cost before `DL_BLIT` existed (PRD R26).
   */
  const blit = (ops, held, x, y, cell) => {
    const left = px(x);
    const top = px(y);
    const side = px(x + cell) - left;
    const down = px(y + cell) - top;
    ops.push(encodeBlit(held.fd,
      left + Math.round((side - held.w) / 2),
      top + Math.round((down - held.h) / 2)));
  };

  /**
   * THE PICTURE FOR ONE ROW: its own bytes if there is a thumbnail, else THE TYPE ICON.
   *
   * THE FALLBACK IS THE WHOLE OF R26'S SECOND HALF and it is the icon the row would have had anyway
   * — a blank square would be a file manager that showed less for knowing more. `--thumb-no-fallback`
   * is the world where it is blank, which is the clause this function exists to make assertable.
   *
   * A LETTERBOXED THUMBNAIL GETS A PLATE and a square one does not. `thumbFit` keeps the aspect
   * ratio, so a wide image in a square cell leaves two bars of paper; the plate is what makes those
   * read as the picture's shape rather than as a drawing that failed halfway.
   */
  const picture = (ops, row, x, y, cell, inkWhenIcon) => {
    /* THE MODE DECIDES FIRST, AND READING THE CACHE WITHOUT ASKING WAS THE DEFECT. A view change
     * repaints at once and the cache is released on the NEXT fill pass, so the frame drawn
     * immediately after a step down into Details blitted a 96-device-px payload into a 16 CSS px
     * glyph box — one frame of a picture four times the size of the row it was in. `view.thumbs`
     * is R26's scope and it is the same test `thumbCellCss` makes, so a mode with no pictures can
     * never draw one whatever the cache still holds. */
    const held = view.thumbs ? thumbFor(row) : null;
    if (held) {
      if (held.w !== px(x + cell) - px(x) || held.h !== px(y + cell) - px(y)) {
        fill(ops, x, y, cell, cell, THUMB_PLATE);
      }
      blit(ops, held, x, y, cell);
      drewPictures += 1;
      return;
    }
    /* `--thumb-no-fallback` IS SCOPED TO THE MODES THAT HAVE PICTURES, and that is a rescope rather
     * than the first spelling. It was "no fallback where a decode was refused or barred", and over
     * this repository's own fixture NOTHING is refused — `logo.png` and `logo.rgba` both decode —
     * so the control turned nothing and verified nothing, which the base brief requires be rescoped
     * and reported rather than shipped. The CLAUSE R26 owes is "a row with no thumbnail still has
     * its type icon", and WHY it has no thumbnail does not change that clause: a format nothing
     * decodes reaches it with the same fixture a corrupt PNG would. In a mode with no pictures at
     * all — Details, Small icons, List — the flag does nothing, which is what keeps it clear of
     * every registered check. */
    if (thumbNoFallback && view.thumbs) return;
    glyph(ops, row, x, y, inkWhenIcon, cell);
    drewIcons += 1;
  };

  /**
   * THE VIEWPORT AS A `DL_CLIP` OP, or `null` when the window has no room for one.
   *
   * SURFACE PIXELS, CONVERTED BY ITS EDGES like every other rectangle here. `win_draw` refuses the
   * WHOLE batch for a clip whose width or height is not positive or whose origin is outside the
   * surface, and a refused batch is a window that stopped repainting with no error a reader can
   * see — so a viewport that small is not named at all, and `paint` draws no rows instead. A
   * degenerate clip is also exactly what a window dragged to its minimum height produces.
   */
  const clipOp = () => {
    const box = FILES_METRICS.viewBox(clientW, clientH);
    const x = px(box.x);
    const y = px(box.y);
    const w = px(box.x + box.w) - x;
    const h = px(box.y + box.h) - y;
    if (w <= 0 || h <= 0 || x >= surfW || y >= surfH) return null;
    return { op: DL_CLIP, a0: x, a1: y, a2: w, a3: h };
  };

  /**
   * THE SORT INDICATOR: a wedge at the TOP of the sorted column's header cell, pointing UP for
   * ascending. Windows 7 draws a triangle in that exact place, and the display list has no path op,
   * so it is three fills of descending width — the glyph's argument applied to four pixels.
   *
   * CENTRED ON THE COLUMN'S BOX, which is `columnBoxes`'s own rectangle, so a check can locate it
   * from the export rather than from a number of its own.
   */
  const sortCaret = (ops, box, dir) => {
    const mid = box.x + box.w / 2;
    for (let r = 0; r < 3; r += 1) {
      const w = dir > 0 ? 5 - r * 2 : 1 + r * 2;
      /* AT THE TOP OF THE CLIENT AREA, which is also the top of the COLUMN BAND: the column
       * header is the first band and the address strip is below it (see `CRUMB_H`).
       * `www/m19.html`'s `caretOf` finds this wedge by filtering the batch for fills inside the top
       * four CSS pixels, so this `1 + r` is a number two files agree on. */
      fill(ops, mid - w / 2, 1 + r, w, 1, HEAD_INK);
    }
  };

  /**
   * ONE DETAILS ROW. EXACTLY WHAT `paint` DREW INLINE BEFORE M23 — moved and not rewritten, because
   * the Details view is what three proof pages read and a reflowed drawing is a pixel nobody meant
   * to move.
   */
  const detailRow = (rowOps, i, row, selected, cols) => {
    const top = rowTop(i, scroll);
    /* A SELECTED ROW INVERTS, which is what a list view does and what makes the selection
     * visible without a second colour to learn. The fill is the row's own KIND colour, so the
     * amber/green distinction survives selection rather than being painted over by one
     * highlight.
     *
     * THE HOVER'S BAND IS UNDER IT AND LOSES TO IT: a row that is both lit and selected reads as
     * selected, because the selection is the reader's choice and the hover is only where their
     * hand is. */
    if (selected) {
      fill(rowOps, PAD, top, clientW - PAD * 2, ROW_H,
        row.dir ? SELECT_FILL_DIR : SELECT_FILL);
    } else if (i === lit) {
      fill(rowOps, PAD, top, clientW - PAD * 2, ROW_H, LIT_FILL);
    }
    const kind = row.dir ? BAND_DIR : (BAND[row.format] || BAND_UNKNOWN);
    /* M23. THE ROW'S PICTURE, WHICH IS ITS OWN BYTES WHERE THERE ARE ANY. In the Details view the
     * thumbnail takes the glyph's box exactly, so the fallback is the icon that was there before
     * and nothing moves — which is what makes R26 a change to what a row SHOWS and not to where
     * anything is. */
    picture(rowOps, row, PAD + 2, top + 2, GLYPH_W, selected ? INK_SELECTED : kind);
    /* M20. A CUT ROW IS DIMMED, which is Explorer's own statement that a move is pending — and
     * the only one available: the clipboard cannot be asked "is this row's path on you" per
     * frame, so the membership set `toClipboard` kept is what this reads. It changes the NAME's
     * ink only, so "cut" and "selected" stay two readings the way "lit" and "selected" do. */
    const cutOut = !!clip && clip.intent === V_CUT && clip.marked.has(row.path);
    /* THE CELLS, ONE PER COLUMN AND IN COLUMN ORDER. `cellOf` decides every string and
     * `columnBoxes` every rectangle, so the column a cell lands in is the column its header names.
     * The NAME is drawn at the row's own size and the three metadata columns one pixel smaller and
     * monospace, which is what makes a column of dates and sizes line its digits up. */
    /* M20. AN OPEN RENAME REPLACES THE NAME CELL WITH A FIELD, and only for the row being
     * renamed: the other three columns still describe the file, which is what tells a reader
     * which row they are editing. */
    const field = editing && editing.row === i ? cols[0] : null;
    for (const box of cols) {
      if (field && box.key === "name") continue;
      cellRun(rowOps, box, cellOf(row, box.key), {
        y: top + TEXT_DY,
        size: box.key === "name" ? TEXT_PX : TEXT_PX - 1,
        rgba: selected ? INK_SELECTED
          : (box.key === "name" ? (cutOut ? INK_DIM : INK) : INK_DIM),
        mono: box.mono,
      });
    }
    if (field) {
      /* THE FIELD, AND THE CARET IS AT ITS RIGHT EDGE AND NOT AFTER THE TEXT. A program cannot
       * measure a string — the renderer has the font and a sum of published advances is only an
       * upper bound for a proportional run (`advanceWidth` in src/abi.mjs) — so a caret drawn
       * where the text is thought to end would sit in the wrong place at every size. The field's
       * edge is a position both sides agree on.
       *
       * MONOSPACED, which is the one family whose width the advance table prices exactly, so a
       * driver outside the process can predict where the draft's glyphs are. */
      // FROM THE NAME'S TEXT ORIGIN AND NOT FROM THE COLUMN'S LEFT EDGE, so the row's glyph stays
      // visible beside the field: the file being renamed is still the file, and hiding its icon
      // under the box loses the one mark that says whether it is a folder.
      const fx = field.textX - 2;
      const fw = Math.max(1, field.right - fx);
      fill(rowOps, fx, top, fw, ROW_H, PAPER);
      stroke(rowOps, fx, top, fw, ROW_H, FOCUS_RING);
      cellRun(rowOps, field, editing.draft, {
        y: top + TEXT_DY, size: TEXT_PX, rgba: INK, mono: true,
      });
      fill(rowOps, field.right - PAD, top + 2, 1, ROW_H - 4, FOCUS_RING);
    }
    if (selected) {
      stroke(rowOps, PAD, top, clientW - PAD * 2, ROW_H, OUTLINE);
    }
    /* THE KEYBOARD CURSOR, LAST AND INSIDE THE ROW. Windows 7 draws a dotted focus rectangle and
     * the display list has no dash pattern, so this is a hairline inset by one CSS pixel — which
     * is what lets a row that is both focused and selected show both rings instead of one hiding
     * the other. Its ink follows the row: `INK_SELECTED` on an inverted band, `FOCUS_RING` on
     * paper, for the contrast reason the selected text already has. */
    if (i === focus) {
      const ring = FILES_METRICS.focusBox(i, scroll, clientW);
      stroke(rowOps, ring.x, ring.y, ring.w, ring.h, selected ? INK_SELECTED : FOCUS_RING);
    }
  };

  /**
   * ONE GRID OR LIST CELL: a picture, and the name under it or beside it.
   *
   * THE CELL IS `itemBox` AND NOTHING ELSE, so what a press finds and what a reader sees are one
   * rectangle — `itemAtPoint` is its declared inverse, and a drawing that laid a cell out with
   * arithmetic of its own is how a click comes to select the file next door.
   *
   * THE ICON IS CENTRED WHEN THE LABEL IS BELOW IT and flush left when the label is beside it,
   * which is Windows' own pair of arrangements: icons under centred names read as a grid, icons
   * before left-aligned names read as a list.
   *
   * THE LABEL IS ELLIPSIZED BY THE RENDERER AND NEVER CUT HERE. A program cannot measure a string
   * and a sum of published advances is only an upper bound for a proportional run, so
   * `DLT_ELLIPSIS` plus the room available is the ABI's answer (`cellRun` says it for a column).
   *
   * A SECOND LINE IS THE TYPE AND THE SIZE, in the modes that have two — which is the whole of what
   * Explorer's Tiles view adds over Medium icons, and what makes a large grid usable at all: a
   * picture with no words under it cannot say whether it is 2 KB or 2 MB.
   */
  const cellItem = (rowOps, i, row, selected) => {
    const cell = itemBox(view, i, scroll, clientW, clientH);
    /* THE BAND IS THE WHOLE CELL, which is what a selected tile looks like in Explorer and is also
     * the only shape a reader can tell from a hover: the cells have gutters between them, so a band
     * narrower than the cell would read as a second kind of mark. */
    if (selected) {
      fill(rowOps, cell.x, cell.y, cell.w, cell.h, row.dir ? SELECT_FILL_DIR : SELECT_FILL);
    } else if (i === lit) {
      fill(rowOps, cell.x, cell.y, cell.w, cell.h, LIT_FILL);
    }
    const kind = row.dir ? BAND_DIR : (BAND[row.format] || BAND_UNKNOWN);
    const cutOut = !!clip && clip.intent === V_CUT && clip.marked.has(row.path);
    const iconX = view.below ? cell.x + (cell.w - view.icon) / 2 : cell.x + 2;
    const iconY = cell.y + (view.below ? 0 : (cell.h - view.icon) / 2);
    picture(rowOps, row, iconX, iconY, view.icon, selected ? INK_SELECTED : kind);
    const labelX = view.below ? cell.x + 2 : cell.x + view.icon + 6;
    const labelW = view.below ? cell.w - 4 : Math.max(1, cell.w - view.icon - 8);
    const labelY = view.below ? cell.y + view.icon : cell.y + (cell.h - view.lines * LABEL_H) / 2;
    const ink = selected ? INK_SELECTED : (cutOut ? INK_DIM : INK);
    /* AN OPEN RENAME REPLACES THE NAME with the field, in the cell's own label box. The icon stays,
     * which is `detailRow`'s rule for the same reason: the file being renamed is still the file. */
    const field = !!editing && editing.row === i;
    if (field) {
      fill(rowOps, labelX, labelY, labelW, LABEL_H, PAPER);
      stroke(rowOps, labelX, labelY, labelW, LABEL_H, FOCUS_RING);
    }
    text(rowOps, field ? editing.draft : row.name, {
      x: view.below ? cell.x + cell.w / 2 : labelX,
      y: labelY + 2,
      size: TEXT_PX,
      rgba: field ? INK : ink,
      flags: DLT_ELLIPSIS | (view.below ? DLT_CENTER : 0) | (field ? DLT_MONO : 0),
      maxWidth: labelW,
    });
    if (view.lines > 1) {
      const sized = sizeText(row);
      text(rowOps, sized ? `${kindOf(row)} \u00b7 ${sized}` : kindOf(row), {
        x: view.below ? cell.x + cell.w / 2 : labelX,
        y: labelY + LABEL_H + 2,
        size: TEXT_PX - 1,
        rgba: selected ? INK_SELECTED : INK_DIM,
        flags: DLT_ELLIPSIS | DLT_MONO | (view.below ? DLT_CENTER : 0),
        maxWidth: labelW,
      });
    }
    if (selected) stroke(rowOps, cell.x, cell.y, cell.w, cell.h, OUTLINE);
    if (i === focus) {
      const ring = focusBoxFor(view, i, scroll, clientW, clientH);
      stroke(rowOps, ring.x, ring.y, ring.w, ring.h, selected ? INK_SELECTED : FOCUS_RING);
    }
  };

  /** WHAT THE LAST FRAME DREW PER ITEM: a PICTURE made of the file's own bytes, or the TYPE ICON.
   *
   *  THE PAIR IS R26'S WHOLE CLAUSE AS A COUNT, and it has to be per-frame rather than cumulative:
   *  "every item has one or the other" is a statement about a drawing, and a cumulative counter
   *  cannot say whether the frame on screen now has a blank square in it. Reset at the top of
   *  `paint` for that reason. */
  let drewPictures = 0;
  let drewIcons = 0;

  /** One frame. EVERY NUMBER IN HERE IS A CSS PIXEL — `fill`, `stroke`, `text` and `cellRun` are
   *  what turn them into surface pixels, and they are the only things that do. */
  const paint = () => {
    // `DL_CLEAR`'s `a0` IS A COLOUR AND NOT A COORDINATE, so it is pushed raw: scaling it would
    // produce a different colour, which is the one way this list could go silently wrong.
    const ops = [{ op: DL_CLEAR, a0: PAPER }];
    drewPictures = 0;
    drewIcons = 0;
    /* THE CLIP DECIDES WHETHER THERE IS A LIST AT ALL, so it is built before the account is
     * written: no viewport means no rows drawn, and reporting rows nobody drew is the harness
     * dishonesty CLAUDE.md names.
     *
     * NAMED `clipRect` AND NOT `clip`, WHICH IS A FIX AND NOT A TIDY. It was `clip`, and it SHADOWED
     * this program's clipboard record of the same name one scope out — so `clip.intent === V_CUT`
     * below read a field off the viewport rectangle, was never true, and a cut row was never
     * dimmed. The two spellings differ by a word; the two meanings do not. */
    const clipRect = clipOp();
    const { first, last } = visible();
    const cols = columnBoxes(clientW);

    /* THE STATUS STRIP, BEFORE THE CLIP, because it sits BELOW the viewport and a canvas clip only
     * ever intersects — drawn after the clip it would be cut away entirely.
     *
     * THE POSITION STATEMENT IS WHAT M17 PUT IN THE HEADER and what M19's four column labels left
     * no room for. It is the same sentence in the same words: `a-b of N` while the list scrolls and
     * `N items` while it does not, which is itself the statement "this list cannot scroll".
     *
     * IT IS THE ONLY RIGHT-ALIGNED RUN BEFORE THE CLIP, AND THAT IS LOAD-BEARING OUTSIDE THIS
     * PROCESS. `www/m18.html`'s `positionLine` reads this statement as "the first `DLT_RIGHT` run
     * ahead of the clip", because before M19 it was the only one there was. So the column labels
     * below are LEFT-aligned at their own boxes — which is also what Explorer does with a column
     * header over right-aligned values — and the selection count is left-aligned too. Give any of
     * them `DLT_RIGHT` and a label is read as the list's position: the clause asserting "this list
     * does not scroll" goes red over a list that does not scroll, which is the shape of defect that
     * takes a day to find.
     *
     * THE SELECTION COUNT IS A SEPARATE RUN so neither reading can be mistaken for the other by
     * something matching text — and `N selected` matches neither of that page's two regexes. */
    const drawn = clipRect ? Math.max(0, last - first + 1) : 0;
    const place = maxScroll() > 0 && drawn > 0
      ? `${first + 1}-${last + 1} of ${rows.length}`
      : `${rows.length} item${rows.length === 1 ? "" : "s"}`;
    const footY = clientH - FOOT_H + 4;
    fill(ops, 0, clientH - FOOT_H, clientW, 1, HEAD_RULE);
    text(ops, place, {
      x: clientW - PAD - TYPE_INSET, y: footY, size: TEXT_PX - 1, rgba: HEAD_INK,
      flags: DLT_RIGHT,
    });
    /**
     * M23. THE SELECTION'S COUNT AND ITS SUMMED SIZE — R29's Details pane, in the strip that is
     * already there rather than in a fourth band.
     *
     * THE SUMMED SIZE IS THE ONE THING R29 SAYS ONLY THIS PLACE CAN SHOW: no column holds it,
     * because a column describes one row. The sum is over the FILES in the selection — a directory's
     * `st_size` is the size of its own entry table and not the size of what is in it (`sizeText`
     * says the same thing for the cell), so folders are counted as items and not as bytes, and the
     * statement says which: `3 selected · 2 files, 5 KB`.
     *
     * A SEARCH SAYS WHAT IT LOOKED AT AND WHAT IT COST, which is R31's own requirement spelled as a
     * sentence a reader can read: the query, how many matched of how many, and for a WALK the
     * directories read and the entries seen. The free filter reports zero for both, which is the
     * distinction — one costs no syscall and the other costs one `readdir` per directory.
     */
    if (query !== "" || walk) {
      const cost = account.searchCost;
      const said = walk
        ? `searching "${query}" — ${cost.dirsRead} dir(s), ${cost.entriesSeen} entries`
        : (cost.entriesSeen > 0
          ? `"${query}" — ${rows.length} of ${cost.entriesSeen} under ${dir}`
            + `${cost.why ? ` (${cost.why})` : ""}`
          : `"${query}" — ${rows.length} of ${allRows.length} here`);
      text(ops, said, {
        x: PAD, y: footY, size: TEXT_PX - 1, rgba: HEAD_INK,
        flags: DLT_ELLIPSIS, maxWidth: Math.max(1, clientW - PAD * 2 - 140),
      });
    } else if (sel.size > 0) {
      const files = [...sel].filter((n) => n < rows.length && !rows[n].dir);
      const bytes = files.reduce((n, at) => n + (Number(rows[at].size) || 0), 0);
      text(ops, `${sel.size} selected`
        + (files.length > 0
          ? ` · ${files.length} file${files.length === 1 ? "" : "s"}, `
            + `${bytes > 0 ? Math.max(1, Math.ceil(bytes / 1024)) : 0} KB`
          : ""), {
        x: PAD, y: footY, size: TEXT_PX - 1, rgba: HEAD_INK,
        flags: DLT_ELLIPSIS, maxWidth: Math.max(1, clientW - PAD * 2 - 140),
      });
    }

    /**
     * M23. THE ADDRESS STRIP, FIRST AND ALSO BEFORE THE CLIP — the breadcrumb, the search field and
     * the view button, in that order from the left.
     *
     * ONE GEOMETRY WITH THE HIT TEST. Every rectangle here comes out of `crumbSegments` and the two
     * fixed widths `crumbHit` tests against, so a press lands on the thing a reader is pointing at —
     * which is `rowTop`'s rule and here it is the whole of R28's "clicking a segment goes there".
     *
     * THE TRAIL AND THE PATH FIELD ARE THE SAME RECTANGLE IN TWO STATES, which is R28's dual
     * nature: the strip either shows the trail or holds the text of the path, never both. The
     * search field is beside it and keeps its own box, because a reader narrowing a listing has not
     * stopped needing to know where they are.
     */
    fill(ops, 0, CRUMB_TOP, clientW, CRUMB_H - CRUMB_SKIRT, CRUMB_FILL);
    const stripRoom = Math.max(0, clientW - SEARCH_W - VIEWBTN_W - CRUMB_PAD);
    if (strip === "path") {
      /* THE PATH FIELD. MONOSPACED for the reason the rename field is: it is the one family whose
       * width is predictable from outside the process, so a driver can say where a character is —
       * and the caret sits at the field's RIGHT EDGE rather than after the text, because a program
       * cannot measure a string (`detailRow`'s field says the same thing). */
      stroke(ops, CRUMB_PAD, CRUMB_TOP + 2, Math.max(1, stripRoom - CRUMB_PAD), CRUMB_H - 4,
        FOCUS_RING);
      text(ops, stripDraft, {
        x: CRUMB_PAD * 2, y: CRUMB_TOP + 5, size: TEXT_PX, rgba: INK,
        flags: DLT_MONO | DLT_ELLIPSIS, maxWidth: Math.max(1, stripRoom - CRUMB_PAD * 3),
      });
      fill(ops, stripRoom - CRUMB_PAD * 2, CRUMB_TOP + 4, 1, CRUMB_H - 8, FOCUS_RING);
    } else {
      const segs = crumbSegments(dir, clientW);
      account.crumbs = segs.map((s) => ({ label: s.label, path: s.path, x: s.x, w: s.w }));
      for (const seg of segs) {
        if (seg.path === dir || dirKey(seg.path) === dirKey(dir)) {
          fill(ops, seg.x, CRUMB_TOP + 2, seg.w, CRUMB_H - 4, CRUMB_LIT);
        }
        text(ops, seg.elided ? `…${seg.label}` : seg.label, {
          x: seg.x + CRUMB_PAD, y: CRUMB_TOP + 5, size: TEXT_PX,
          // THE DIRECTORY A READER IS IN IS THE BRIGHT ONE, and its ancestors are dim: a trail
          // where every segment looked alike would not say which end of it is here.
          rgba: dirKey(seg.path) === dirKey(dir) ? INK : INK_DIM,
          flags: DLT_MONO | DLT_ELLIPSIS, maxWidth: Math.max(1, seg.w - CRUMB_PAD * 2),
        });
        // THE SEPARATOR IS A CHEVRON OUT OF TWO FILLS, because the display list has no path op —
        // the same argument the folder glyph and the sort caret are drawn under.
        if (seg.path !== segs[segs.length - 1].path) {
          fill(ops, seg.x + seg.w + 1, CRUMB_MID - 3, 1, 3, INK_DIM);
          fill(ops, seg.x + seg.w + 2, CRUMB_MID, 1, 3, INK_DIM);
        }
      }
    }
    /* THE SEARCH FIELD. It is drawn in every strip state, because a query outlives the field being
     * open — a reader who typed and pressed Enter is still looking at a narrowed listing, and a box
     * that emptied itself would leave them with no statement of why. */
    const searchX = clientW - VIEWBTN_W - SEARCH_W;
    stroke(ops, searchX, CRUMB_TOP + 2, SEARCH_W - CRUMB_PAD, CRUMB_H - 4,
      strip === "search" ? FOCUS_RING : HEAD_RULE);
    const inField = strip === "search" ? stripDraft : query;
    text(ops, inField === "" ? "Search" : inField, {
      x: searchX + CRUMB_PAD, y: CRUMB_TOP + 5, size: TEXT_PX,
      rgba: inField === "" ? INK_DIM : INK,
      flags: DLT_MONO | DLT_ELLIPSIS, maxWidth: SEARCH_W - CRUMB_PAD * 3,
    });
    if (strip === "search") {
      fill(ops, searchX + SEARCH_W - CRUMB_PAD * 2, CRUMB_TOP + 4, 1, CRUMB_H - 8, FOCUS_RING);
    }
    /* THE VIEW BUTTON: four cells of a 2x2 grid, which is the picture Windows 7 puts on it. It
     * steps the view mode, and it exists because Ctrl+wheel is otherwise the only gesture that
     * reaches one — see `VIEWBTN_W`. */
    const btnX = clientW - VIEWBTN_W;
    fill(ops, btnX, CRUMB_TOP + 2, VIEWBTN_W - CRUMB_PAD, CRUMB_H - 4, CRUMB_LIT);
    for (let q = 0; q < 4; q += 1) {
      fill(ops, btnX + 4 + (q % 2) * 6, CRUMB_TOP + 7 + Math.floor(q / 2) * 6, 4, 4, HEAD_INK);
    }

    /* THE HEADER, ALSO BEFORE THE CLIP — which is the whole reason the clip exists. A scrolled
     * row's top is above the header's baseline, so an unclipped list paints its name over these
     * words; the check reads the header's pixels back for exactly that reason.
     *
     * SINCE M19 IT IS FOUR COLUMN LABELS AND NOTHING ELSE, each over the column it names, with a
     * wedge on the one the sort is on. A label is what tells a reader the right-hand text is a DATE
     * and not part of the name, and it is also the thing a press on it sorts — so the labels and
     * the hit test read one geometry (`columnBoxes`) and cannot disagree about which column a
     * reader pointed at. There is no scrollbar — a thumb is dragged, and a drag on one would be a
     * gesture this program cannot route. */
    /* M23. AND THE COLUMN LABELS BELONG TO THE DETAILS VIEW ALONE, because the columns do: a grid
     * of icons has no Name column for a label to sit over, and a `Date modified` header above a
     * row of pictures names nothing. WHAT REPLACES THEM IS A SORT STRIP, not blank paper — the
     * header band keeps its height in every mode (see `VIEW_TOP`), so the space is there either
     * way, and a reader in Large icons otherwise has no way at all to see which order they are
     * looking at. A press on it still sorts, which keeps "a press above the viewport sorts" one
     * rule in seven modes. */
    if (view.flow === FLOW_ROWS) {
      for (const box of cols) {
        text(ops, box.label, {
          // The `Name` label keeps the column's own text origin, because the rows' names are there
          // and a label over its values is the point. The other three have no left text origin of
          // their own — their cells hang off the right edge — so the label takes the box's left.
          x: box.key === "name" ? box.textX : box.x + 2,
          y: PAD,
          size: TEXT_PX,
          rgba: HEAD_INK,
          flags: DLT_BOLD | DLT_ELLIPSIS,
          maxWidth: Math.max(1, box.w - PAD),
        });
        if (box.key === sort.key) sortCaret(ops, box, sort.dir);
      }
    } else {
      const named = COLUMNS.find((c) => c.key === sort.key);
      text(ops, `${view.label} \u00b7 sorted by ${named ? named.label : sort.key}`, {
        x: NAME_X, y: PAD, size: TEXT_PX, rgba: HEAD_INK,
        flags: DLT_BOLD | DLT_ELLIPSIS,
        maxWidth: Math.max(1, clientW - NAME_X - PAD),
      });
      sortCaret(ops, { x: PAD, w: GLYPH_W }, sort.dir);
    }
    fill(ops, PAD, HEAD_H - 4, clientW - PAD * 2, 1, HEAD_RULE);

    /* FROM HERE DOWN THE LIST IS CLIPPED. No reset follows it: `Surface.replay` resets the clip at
     * the top of every batch (`src/abi.mjs`'s `DL_CLIP` docstring), so a clip is batch-scoped and a
     * trailing `DLC_RESET` would be a second definition of that rule. */
    if (clipRect) ops.push(clipRect);

    // NO CLIP, NO ROWS: `first - 1` is an empty range, and it is the ONE place that decision is
    // taken — a row drawn outside a viewport this program could not name would paint the header.
    const lastDrawn = clipRect ? last : first - 1;
    let shown = 0;
    let capped = 0;
    for (let i = first; i <= lastDrawn; i += 1) {
      const row = rows[i];
      const selected = sel.has(i);
      /* ONE ITEM IS BUILT APART AND THEN MEASURED, WHICH IS WHAT `DL_MAX_OPS` COSTS. A batch over
       * the cap is refused WHOLE (`win_draw`), and a refused batch is a window that stopped
       * repainting with no error a reader can see. So the loop stops while there is still room and
       * SAYS HOW MANY ITEMS IT DROPPED, rather than sending a batch that draws nothing.
       *
       * M23: AND THE TWO FLOWS COST DIFFERENT AMOUNTS. A Details row is four text runs plus its
       * fills; a grid cell is ONE picture — a `DL_BLIT` is one op where a 16x16 image would have
       * been 256 fills (PRD R26) — plus one or two label runs. The measurement is the same either
       * way, which is why the cap is applied here and not inside the drawers. */
      const rowOps = [];
      /* THE MARK COUNTS ARE SNAPSHOTTED AND PUT BACK IF THE ITEM IS DISCARDED. `picture` raises one
       * of them as it builds the ops, and the cap below can then throw those ops away — so without
       * this the counters described an item nobody drew, and `drewPictures + drewIcons ===
       * shownRows` (which is R26's fallback clause as arithmetic) was false by exactly the number
       * the cap dropped. */
      const pictureWas = drewPictures;
      const iconWas = drewIcons;
      if (view.flow === FLOW_ROWS) detailRow(rowOps, i, row, selected, cols);
      else cellItem(rowOps, i, row, selected);
      // ONE op of headroom is kept for the band below, which is two ops and is drawn at most once.
      if (ops.length + rowOps.length + 2 > DL_MAX_OPS) {
        capped = lastDrawn - i + 1;
        drewPictures = pictureWas;
        drewIcons = iconWas;
        break;
      }
      ops.push(...rowOps);
      shown += 1;
    }
    account.firstRow = shown > 0 ? first : 0;
    account.shownRows = shown;
    account.thumbs.drewPictures = drewPictures;
    account.thumbs.drewIcons = drewIcons;
    if (capped !== account.cappedRows) {
      account.cappedRows = capped;
      if (capped > 0) {
        env.std.say(env, `${NAME}: ${capped} row(s) past a ${DL_MAX_OPS}-op batch were not drawn\n`);
      }
    }

    /* THE RUBBER BAND, LAST AND INSIDE THE CLIP, because it is drawn over the rows it is selecting
     * and bounded by the same viewport they are. Its corners are CONTENT coordinates, so the offset
     * comes back off here — the one place that conversion happens. */
    if (band) {
      const r = bandBox(band);
      fill(ops, r.x, r.y - scroll, r.w, r.h, BAND_WASH);
      stroke(ops, r.x, r.y - scroll, r.w, r.h, BAND_EDGE);
    }

    /* `--menu-in-surface`: THE MENU A PROCESS DRAWS ITSELF, which is the control and not the
     * product. It is drawn here, last and INSIDE the clip, because that is where a program's
     * drawing can go — and that is the whole demonstration: the popup is cut by the viewport
     * rectangle and then again by `.window-body`'s `overflow: hidden`, so a menu raised near the
     * bottom edge of a frame loses the rows a reader was about to pick from. `win_menu` exists
     * because neither cut is avoidable from in here. */
    if (menuInSurface && menu) {
      const h = MENU_PAD * 2 + menu.rows.length * MENU_ROW_H;
      fill(ops, menu.at.x, menu.at.y, MENU_W, h, PAPER);
      stroke(ops, menu.at.x, menu.at.y, MENU_W, h, OUTLINE);
      menu.rows.forEach((r, n) => {
        const y = menu.at.y + MENU_PAD + n * MENU_ROW_H;
        if ((r.flags | 0) & WITEM_SEPARATOR) {
          fill(ops, menu.at.x + MENU_PAD, y + MENU_ROW_H / 2, MENU_W - MENU_PAD * 2, 1, HEAD_RULE);
          return;
        }
        text(ops, r.label, {
          x: menu.at.x + MENU_PAD * 2,
          y: y + TEXT_DY,
          size: TEXT_PX,
          rgba: ((r.flags | 0) & WITEM_DISABLED) ? INK_DIM : INK,
        });
      });
    }
    return env.win.draw(made.fd, ops);
  };
  paint();

  /** THE BOUNDARY, AND THE ONLY PLACE A DEVICE PIXEL BECOMES THIS PROGRAM'S OWN UNIT. `w` and `h`
   *  arrive from `std.resurface`, which divided the event's device-px box by the ratio the event
   *  carried; from here down everything is CSS px again. Nothing else in this file touches `S`
   *  except `px`, which is the other half of the same border. */
  const relayout = (w, h, dpr) => {
    S = dpr;
    clientW = w;
    clientH = h;
    /* HOW MANY ROWS THE VIEWPORT HOLDS, REPORTED AND NOT ENFORCED. It was the row CAP before M17
     * and nothing reads it as one now — `visible` bounds the drawn rows by the viewport itself, so
     * a count and a geometry cannot disagree. It stays in the account because "how much of this
     * directory can a reader see at once" is the question a resize is about. */
    /* M23: `pageStepFor` CALLS `rowsThatFit` IN THE `rows` FLOW, so this is the same number it has
     * always been in Details, and in a grid it is lanes times the rows that fit — which is what
     * "how much of this directory can a reader see at once" means when a line holds four files. */
    account.maxRows = pageStepFor(view, rows.length, w, h);
    account.lanes = lanesOf(view, FILES_METRICS.viewBox(w, h)).lanes;
    account.client = { w, h };
    account.dpr = dpr;
    /* THE OFFSET IS RE-CLAMPED AGAINST THE NEW HEIGHT, which is the bottom clamp doing the work a
     * resize creates: a window made taller shows more rows, so an offset that was the end of the
     * list is now past it, and leaving it there is a strip of empty paper under the last row that no
     * wheel can scroll away. `scrollBy(0)` is not that call — it returns early on a zero delta and
     * must, or every pointer move would count as a clamp. */
    const limit = maxScroll();
    // `--unclamped-scroll` REACHES HERE TOO, because this is the SAME end clamp applied at a
    // different moment. Gating only `scrollBy` left a control a resize silently undid: proof 2
    // re-places this window, and the re-clamp pulled the offset back inside the range the control
    // had just been asked to leave.
    if (scroll > limit && !unclampedScroll) scroll = limit;
    account.scroll = scroll;
    account.scrollMax = limit;
    /* A SELECTION SURVIVES A RESIZE NOW, and that is the scroll's doing rather than an omission: a
     * row the window got too short for is SCROLLED to, not gone, so dropping the selection would
     * discard a choice the reader can still reach. The pre-M17 rule dropped it because the row left
     * the drawn list entirely. A press is still dropped if its row left the LIST, which only an
     * empty directory could do, so there is nothing left to test.
     *
     * M18: THE CURSOR IS NOT SCROLLED TO EITHER. A resize is the reader's gesture on the WINDOW,
     * and moving the list under it to chase a cursor they are not using would be this program
     * taking over a scroll they did not ask for. The next arrow key reveals it, which is the one
     * moment the cursor's position is what the reader is thinking about. */
  };

  /* `--css-px-surface`: THE UNIT ERROR, ON PURPOSE, AND IT CANNOT GO THROUGH `std.resurface` —
   * that helper passes the event's DEVICE pixels through unscaled precisely so this is unwritable.
   * So the control asks for the box divided by the ratio: the CSS numbers a program's constants are
   * in, which is what every surfaced program asked `win_surface` for before M16. The surface is
   * then half the client box on each axis at dpr 2, the page stretches it to fit, and the result is
   * the blurry half-size list a reader reported — with the resize path otherwise working, so what
   * this control moves is the SCALE and nothing else. */
  const askInCssPx = (ev) => {
    const box = clientBoxAt(ev);
    const w = Math.round(box.w / box.dpr);
    const h = Math.round(box.h / box.dpr);
    const rc = env.win.surface(made.fd, w, h);
    if (rc < 0) {
      account.refusedSurfaces += 1;
      account.surfaceWhy = `win_surface: ${env.std.errnoName(rc)}`;
      return;
    }
    account.resurfaces += 1;
    surfW = w;
    surfH = h;
    account.surface = { w, h };
    relayout(w, h, 1);
  };

  /* ---- M18: THE CURSOR, THE ACTIVATION VERB AND BACK ---------------------------------------- */

  /**
   * SOMETHING THIS WINDOW WILL NOT DO, SAID BY NAME AND COUNTED.
   *
   * `account.why` is deliberately not touched. It is the EXIT reason and the event loop breaks on
   * it — `startDrag` uses it that way, so a drag onto a directory ends the program — and a refused
   * open must leave a reader with a window they can go on using.
   *
   * THE NAME IS THE POINT. A count alone is satisfied by a window that refused the wrong row, so
   * `refusals` carries what was asked for beside why it was declined, and a check reads the entry
   * rather than the number.
   */
  /* M20: AND THE ERRNO IS A SEPARATE FIELD, NOT PART OF `why`. Every mutating verb refuses for a
   * reason the KERNEL named — EROFS on a read-only mount, ENOTEMPTY on a folder with things in it,
   * EEXIST on an occupied name — and a check that matched a sentence could not tell those apart.
   * `errno` is the name and not the number, because the number is the ABI's and the name is what a
   * reader and a check both read. Absent (rather than `""`) when the refusal is this program's own,
   * so a clause asserting "it refused with an errno" cannot pass for one that had none. */
  const refuse = (what, why, errno = 0) => {
    account.refused += 1;
    const entry = { what: String(what), why };
    if (errno) entry.errno = env.std.errnoName(errno);
    account.refusals.push(entry);
    account.refusalWhy = `${what}: ${why}`;
    env.std.say(env, `${NAME}: ${what}: ${why}\n`);
    return false;
  };

  /**
   * SCROLL THE LEAST THAT BRINGS ROW `i` FULLY INSIDE THE VIEWPORT, CSS px.
   *
   * IT IS NOT A CLAMP AND MUST NOT BE COUNTED AS ONE. `scrollBy` counts an end it refused to pass;
   * here nothing was refused — the offset is CHOSEN — so `dyTotal` and `clamped` are untouched, and
   * `scroll === dyTotal` stays an assertion about what the wheel did.
   *
   * THE REVEALED ROW KEEPS THE LIST'S OWN `PAD` beside it, which is what makes the two ends come
   * out exact: revealing row 0 lands on offset 0, and revealing the last row lands on `scrollMax`
   * (the pad takes the target past it and the clamp brings it back).
   */
  const revealRow = (i) => {
    if (i < 0 || i >= rows.length) return false;
    const box = FILES_METRICS.viewBox(clientW, clientH);
    if (box.h <= 0 || box.w <= 0) return false;
    /* M23. ALONG THE MODE'S OWN AXIS, which is what makes one function reveal a row in Details and
     * a cell in the List — where "scroll to it" means sideways. The near edge, the far edge and the
     * cell's extent are all read off the mode's geometry at offset ZERO, because the arithmetic is
     * about where the content IS and not about where it currently sits. */
    const axis = axisOf(view);
    const cell = itemBox(view, i, 0, clientW, clientH);
    const near = axis === "x" ? cell.x : cell.y;
    const extent = axis === "x" ? cell.w : cell.h;
    const edge = axis === "x" ? box.x : box.y;
    const room = axis === "x" ? box.w : box.h;
    let next = scroll;
    if (near - PAD - scroll < edge) next = near - PAD - edge;
    else if (near + extent + PAD - scroll > edge + room) next = near + extent + PAD - edge - room;
    next = Math.max(0, Math.min(maxScroll(), next));
    if (next === scroll) return false;
    scroll = next;
    account.scroll = scroll;
    account.scrollMax = maxScroll();
    return true;
  };

  /** Put the cursor on row `i`, clamped to the list, and scroll to it. A CURSOR OUTSIDE THE
   *  VIEWPORT IS A CURSOR ON A ROW NOBODY CAN SEE — and the clip makes that literal, so the move
   *  and the reveal are one operation rather than two a caller could forget to pair. */
  const focusAt = (i) => {
    if (rows.length === 0) return refuse("the list", "is empty, so there is no row to focus");
    const next = Math.max(0, Math.min(rows.length - 1, i));
    const moved = next !== focus;
    if (moved) setFocus(next);
    return revealRow(next) || moved;
  };

  /** Move the cursor by `delta` rows. WITH NOTHING FOCUSED THE CURSOR ENTERS AT THE NEAR END AND
   *  DOES NOT ALSO TAKE THE STEP: a first Down lands on the first row and a first Page Down lands
   *  there too, rather than a page into a list the reader has not looked at yet. That is an entry
   *  rule and not an activation — `focus` is `-1` until a key asks for a row, which is what keeps a
   *  first Enter a refusal. */
  const moveFocus = (delta) => {
    if (rows.length === 0) return refuse("the list", "is empty, so there is no row to focus");
    if (focus < 0) return focusAt(delta > 0 ? 0 : rows.length - 1);
    return focusAt(focus + delta);
  };

  /**
   * ENTER `next` IN THIS WINDOW: new rows, a new title, and a reader who has not lost their place
   * in a stack of windows. A re-list and not a spawn, because a file manager that opened a window
   * per folder is a window manager's problem rather than a file manager.
   *
   * EVERYTHING THAT INDEXES THE OLD LIST IS DROPPED HERE. The offset, the selection, the press and
   * the cursor all named rows in a directory that is gone, and carrying any of them over is how a
   * drag comes to publish the bytes of a file the reader never touched.
   *
   * THE LISTING IS DONE BEFORE ANYTHING IS COMMITTED, so a directory that cannot be read leaves the
   * window exactly as it was — with the refusal named. A half-applied navigation would be a title
   * naming one directory over the rows of another.
   */
  /**
   * SORT BY COLUMN `key`, OR REVERSE IT.
   *
   * A CLICK ON A COLUMN THAT IS NOT THE SORT COLUMN sorts ASCENDING by it. A click on the one that
   * IS reverses it — EXCEPT the very first click, because the opening order is name-ascending and
   * nobody chose it: a reader looking at an ascending list who clicks `Name` expects the order they
   * are looking at and not its opposite. `sort.chosen` is the state that tells the two apart.
   *
   * THE SELECTION GOES AND THE CURSOR STAYS ON ITS ROW. The selection named POSITIONS in an order
   * that no longer exists, so carrying it over would highlight rows the reader never chose — the
   * same argument `relist` makes. The cursor is carried by IDENTITY instead of by index, because a
   * reader's place in a list is the FILE they were on: an index would leave the ring on whatever
   * happened to land in that slot.
   */
  /* ---- M23: THE BREADCRUMB, THE PATH FIELD AND THE SEARCH ---------------------------------- */

  /**
   * GO TO A BREADCRUMB SEGMENT. R28's headline: clicking a segment goes there.
   *
   * IT GOES THROUGH `relist`, WHICH IS WHERE HISTORY LIVES — M18 built the Back stack and the row
   * says so, so a crumb press pushes exactly as a double-click on a folder does and Backspace
   * undoes it. A segment that navigated by some other route would be a navigation Back could not
   * reach, which is the one thing a trail must not be.
   *
   * THE SEGMENT A READER IS ALREADY IN IS NOT A NAVIGATION. Pressing it re-lists nothing and pushes
   * nothing: a history entry for "where I already was" makes Back a no-op the reader has to press
   * twice.
   */
  const goToCrumb = (seg) => {
    if (!seg) return false;
    if (dirKey(seg.path) === dirKey(dir)) {
      // AND IT CLEARS AN OPEN SEARCH, which is the one thing pressing "here" can usefully do: a
      // reader looking at a filtered listing who presses the folder they are in means "show me it".
      if (query === "" && strip === "trail" && walked === "") return false;
      const hadWalked = walked !== "";
      query = "";
      walk = null;
      walked = "";
      strip = "trail";
      stripDraft = "";
      account.strip = strip;
      account.stripDraft = "";
      /* A WALK'S RESULT SET IS NOT THIS DIRECTORY, SO IT IS RE-READ AND NOT RE-COMMITTED. After a
       * walk `allRows` holds matches from all over the tree; clearing the query and re-committing
       * it left the window showing files from elsewhere AS IF they were in this directory, with
       * nothing on screen to say why — which is the wrong-file class of defect this program has
       * paid for twice. `reread` is what makes "show me this folder" mean this folder. */
      if (hadWalked) return reread([]);
      commitRows(allRows);
      applyFilter();
      return true;
    }
    if (!relist(seg.path)) return false;
    account.crumbNav += 1;
    return true;
  };

  /** OPEN THE PATH FIELD, holding the directory this window is in — R28's "becomes an editable path
   *  on a click in the empty strip". The draft starts as the CURRENT path and not empty, because a
   *  reader editing an address is almost always changing the end of it. */
  const openPath = () => {
    if (strip === "path") return false;
    strip = "path";
    stripWas = dir;
    stripDraft = dir;
    account.strip = strip;
    account.stripDraft = stripDraft;
    account.pathEdits += 1;
    account.pathWas = stripWas;
    // AN OPEN RENAME GOES: two text fields cannot both own the keyboard, which is `strip`'s whole
    // reason for being one value rather than two booleans.
    if (editing) cancelRename();
    return true;
  };

  /** OPEN THE SEARCH FIELD, holding whatever query is already in force so a reader can narrow or
   *  widen it rather than retype it. Alt+D opens the path field and Ctrl+F opens this one, which
   *  are Windows' own two bindings. */
  const openSearch = () => {
    if (strip === "search") return false;
    strip = "search";
    stripWas = query;
    stripDraft = query;
    account.strip = strip;
    account.stripDraft = stripDraft;
    if (editing) cancelRename();
    return true;
  };

  /** CLOSE WHICHEVER FIELD IS OPEN AND PUT BACK WHAT IT HELD. Esc's behaviour, and the reason the
   *  draft and the original are two variables: a field abandoned must leave the listing exactly as
   *  it was, which for the search field means re-applying the query that was in force. */
  const closeStrip = ({ restore = true } = {}) => {
    if (strip === "trail") return false;
    const was = strip;
    strip = "trail";
    stripDraft = "";
    account.strip = strip;
    account.stripDraft = "";
    /* AND A COMMITTED WALK IS NOT RESTORED OVER. See `walked`: the listing is no longer this
     * directory's, so the query is the only thing that says what it is. */
    if (restore && was === "search" && walked === "" && query !== stripWas) {
      query = stripWas;
      applyFilter();
    }
    return true;
  };

  /**
   * TYPE A BYTE INTO WHICHEVER FIELD IS OPEN. Answers whether a repaint is owed.
   *
   * THE SEARCH FILTERS AS IT IS TYPED (R31) AND THE PATH DOES NOT. A path is not a prefix of a
   * place — `/Users/Defaul` is not a directory — so re-listing per keystroke would be a `readdir`
   * per character answering ENOENT; the path field commits on Enter. A query IS a prefix of a
   * narrower query, so every keystroke is a legitimate narrower listing and costs no syscall at all:
   * the filter runs over the rows already in hand.
   */
  const typeStrip = (b) => {
    if (b === KEY_BACKSPACE) {
      if (stripDraft === "") return false;
      stripDraft = stripDraft.slice(0, -1);
      account.stripDraft = stripDraft;
      if (strip === "search") { query = stripDraft; applyFilter(); }
      return true;
    }
    if (b < PRINTABLE_LO || b > PRINTABLE_HI) return false;
    // COUNTED PER NARROWING AND NOT PER KEYSTROKE: `searches` is how many times the listing was
    // narrowed by a new query, which is the figure that says the filter ran.
    if (strip === "search") account.searches += 1;
    /* BOUNDED, AND BY THE SAME CEILING THE RENAME FIELD USES. `NAME_MAX` is a byte count and these
     * bytes are one each; a path may be longer than one component, so the path field gets four
     * times the room and the search field one component's worth — which is what a name is. */
    const cap = strip === "path" ? NAME_MAX * 4 : NAME_MAX;
    if (stripDraft.length >= cap) return false;
    stripDraft += String.fromCharCode(b);
    account.stripDraft = stripDraft;
    if (strip === "search") { query = stripDraft; applyFilter(); }
    return true;
  };

  /**
   * COMMIT WHICHEVER FIELD IS OPEN — Enter.
   *
   * THE PATH FIELD NAVIGATES, through `relist`, so a typed address is in the Back stack exactly as
   * a crumb press and a double-click are. A path that cannot be read is REFUSED BY NAME with the
   * kernel's own errno and the FIELD STAYS OPEN, which is the only useful thing to do with a typo:
   * closing it would throw away what the reader typed and leave them to start again.
   *
   * THE SEARCH FIELD STARTS THE DEEP WALK. The filter has already run — every keystroke narrowed the
   * listing — so Enter is the reader asking for the one thing the filter cannot give them: matches
   * BELOW this directory. That is what `walk` is, and it is bounded and chunked and says what it
   * cost.
   */
  const commitStrip = () => {
    if (strip === "path") {
      const want = stripDraft.trim();
      if (want === "") return refuse("the address", "is empty");
      if (dirKey(want) === dirKey(dir)) return closeStrip({ restore: false });
      if (!relist(want)) return false;
      // `relist` ALREADY CLOSED THE STRIP, because it resets everything a listing indexes and the
      // field is one of them. Counted here, where the navigation is known to have happened.
      account.crumbNav += 1;
      return true;
    }
    if (strip === "search") {
      if (stripDraft === "") return refuse("the search", "is empty, so there is nothing to look for");
      return beginWalk();
    }
    return false;
  };

  /* ---- M23: THE BOUNDED, CHUNKED WALK (R31) ------------------------------------------------ */

  /**
   * START A DEEP SEARCH UNDER THE OPEN DIRECTORY.
   *
   * WHAT IT SEARCHES, PLAINLY: every entry's NAME, in this directory and in every directory under
   * it, to a depth of `SEARCH_MAX_DEPTH` and a ceiling of `SEARCH_MAX_ENTRIES` entries. Not file
   * CONTENTS — there is no index and no `grep`, and reading every byte of a tree to answer a
   * keystroke is a cost nothing here could bound.
   *
   * WHAT IT COSTS, PLAINLY: one `readdir` per directory (which is `std.listDir`'s rounds, so a
   * directory of 4,000 is several calls), plus ONE `lstat` PER MATCH AND NOT PER ENTRY. That second
   * half is the one real cost decision in here and it is A10's argument applied where A10 cannot
   * reach: a listing needs a stat for every row because the Date and Size columns describe every
   * row, and a WALK needs one only for the rows it is going to show. A walk that statted every
   * entry would pay 20,000 syscalls to display forty.
   *
   * THE RESULT REPLACES THE LISTING, and the rows carry paths from elsewhere in the tree — so the
   * name cell is the file's name and the TYPE cell is still its type, which is what makes a search
   * result a row a reader can act on with the same verbs.
   */
  const beginWalk = () => {
    query = stripDraft;
    walk = {
      /* THE QUERY IS CAPTURED HERE AND READ FROM THE WALK, never from `query`: a chunk in flight
       * must match what the reader pressed Enter on, and `query` is live state a keystroke moves. */
      query,
      stack: [{ path: dir, depth: 0 }],
      seen: 0,
      dirs: 0,
      statted: 0,
      found: [],
      from: performance.now(),
      chunks: 0,
      why: "",
    };
    account.deepSearches += 1;
    account.searches += 1;
    account.query = query;
    account.searchCost = { dirsRead: 0, entriesSeen: 0, statted: 0, ms: 0, chunks: 0, why: "" };
    env.std.say(env, `${NAME}: searching ${dir} and below for "${query}" — names only, to depth `
      + `${SEARCH_MAX_DEPTH} and ${SEARCH_MAX_ENTRIES} entries\n`);
    return true;
  };

  /**
   * ONE CHUNK OF THE WALK. Answers whether a repaint is owed, and clears `walk` when it is done.
   *
   * CHUNKED AT `SEARCH_CHUNK` ENTRIES, which is R31's own requirement — the window keeps servicing
   * input because this returns to the event loop and the loop polls. A walk that ran to completion
   * inside one turn would make a 20,000-entry tree an unresponsive window, and the only symptom
   * would be a reader's keystroke arriving seconds late.
   *
   * BOTH CEILINGS REFUSE BY NAME AND NEITHER STOPS SILENTLY. `why` is what the status strip says, so
   * a result list that is short because the walk was cut off is distinguishable from one that is
   * short because the tree has little in it — which is the whole difference between a search a
   * reader can trust and one they cannot.
   */
  const stepWalk = () => {
    if (!walk) return false;
    walk.chunks += 1;
    let budget = SEARCH_CHUNK;
    while (budget > 0 && walk.stack.length > 0) {
      const at = walk.stack.pop();
      const entries = env.std.listDir(env, at.path);
      walk.dirs += 1;
      if (typeof entries === "number") {
        // A DIRECTORY THAT CANNOT BE READ IS SKIPPED AND COUNTED, not fatal: a walk that stopped at
        // the first unreadable subtree would answer a reader's search with a silence that means
        // "no matches" and is nothing of the kind.
        continue;
      }
      const base = at.path.endsWith("/") ? at.path : `${at.path}/`;
      for (const e of entries) {
        if (e.name === "." || e.name === "..") continue;
        walk.seen += 1;
        budget -= 1;
        if (walk.seen > SEARCH_MAX_ENTRIES) {
          walk.why = `stopped at the ${SEARCH_MAX_ENTRIES}-entry ceiling`;
          walk.stack.length = 0;
          break;
        }
        const isDir = e.type === DT_DIR;
        if (isDir && at.depth + 1 < SEARCH_MAX_DEPTH) {
          walk.stack.push({ path: `${base}${e.name}`, depth: at.depth + 1 });
        } else if (isDir && walk.why === "") {
          walk.why = `stopped at depth ${SEARCH_MAX_DEPTH}`;
        }
        if (!searchMatch(e.name, walk.query)) continue;
        // ONE `lstat` PER MATCH, which is this walk's cost decision (see `beginWalk`).
        walk.statted += 1;
        walk.found.push(makeRow(base, e.name, isDir));
      }
    }
    const done = walk.stack.length === 0;
    account.searchCost = {
      dirsRead: walk.dirs,
      entriesSeen: walk.seen,
      statted: walk.statted,
      ms: performance.now() - walk.from,
      chunks: walk.chunks,
      why: walk.why,
    };
    if (!done) return false;
    /* THE RESULT IS COMMITTED AS THE LISTING AND THE FILTER IS NOT RE-APPLIED TO IT. Every row in
     * `found` already matched, so filtering again would be the same test twice — and `commitRows`
     * would apply it against `allRows`, which is now the result set. */
    allRows = walk.found;
    rows = walk.found;
    walked = walk.query;
    sortRows(rows);
    account.rows = reportRows();
    account.matched = rows.length;
    account.listed = rows.length;
    sel = new Set();
    anchor = -1;
    reportSelection();
    setFocus(-1);
    setLit(-1);
    scroll = 0;
    account.scroll = 0;
    account.scrollMax = maxScroll();
    dropAllThumbs();
    account.thumbs.ready = 0;
    account.thumbs.bytes = thumbBytes;
    env.std.say(env, `${NAME}: ${rows.length} match(es) for "${query}" under ${dir} — `
      + `${walk.dirs} directories read, ${walk.seen} entries seen, ${walk.statted} statted, `
      + `${Math.round(account.searchCost.ms)} ms`
      + `${walk.why ? `, ${walk.why}` : ""}\n`);
    walk = null;
    return true;
  };

  /* ---- M23: SWITCHING THE VIEW ------------------------------------------------------------- */

  /**
   * GO TO VIEW `id`. Answers whether a repaint is owed; refuses an unknown id by name.
   *
   * THE OFFSET IS RESET AND NOT CONVERTED, and that is a decision rather than laziness. The two
   * flows scroll along different axes and the cells have different pitches, so there is no offset in
   * Large icons that means what a given offset meant in Details — a conversion would be a guess
   * dressed as arithmetic, and it would put a reader somewhere neither mode's arithmetic names.
   * THE SELECTION AND THE CURSOR SURVIVE, because both are indices into `rows` and `rows` has not
   * changed: what the reader chose is still what they chose, in a different picture. The cursor is
   * then REVEALED, which is the one thing a reader needs after the layout moves under them.
   *
   * THE FOLDER REMEMBERS, which is R27's last clause. Written on the way OUT of a mode as well as
   * in, so the entry is the mode the reader was last in here and not the mode they first picked.
   */
  const setView = (id) => {
    const next = VIEW_BY_ID[id];
    if (!next) {
      return refuse(String(id), `is not a view (${VIEWS.map((v) => v.id).join(", ")})`);
    }
    if (next.id === view.id) return false;
    view = next;
    viewByDir.set(dirKey(dir), view.id);
    account.view = view.id;
    account.viewLabel = view.label;
    account.viewFlow = view.flow;
    account.viewAxis = axisOf(view);
    account.viewSwitches += 1;
    account.viewsRemembered = viewByDir.size;
    account.lanes = lanesOf(view, FILES_METRICS.viewBox(clientW, clientH)).lanes;
    scroll = 0;
    account.scroll = 0;
    account.scrollMax = maxScroll();
    account.maxRows = pageStepFor(view, rows.length, clientW, clientH);
    // A BAND AND A PRESS ARE IN THE OLD LAYOUT'S COORDINATES, so both go. A gesture that survived a
    // view change would finish by selecting whatever cell the new layout put under a stale corner.
    band = null;
    press = null;
    dragging = false;
    setLit(-1);
    // AN OPEN RENAME GOES TOO: the field is drawn in the name cell's rectangle, and the new mode
    // puts that rectangle somewhere else — a box floating over a different file is the defect.
    if (editing) cancelRename();
    forgetMenu();
    if (focus >= 0) revealRow(focus);
    env.std.say(env, `${NAME}: ${view.label}${view.thumbs ? ", with thumbnails" : ""}, `
      + `${account.lanes} across, scrolls ${axisOf(view) === "x" ? "sideways" : "down"}\n`);
    return true;
  };

  /** STEP THE VIEW ALONG THE `VIEWS` TABLE — the slider A1 names, which is Ctrl+wheel. `by` is
   *  POSITIVE towards smaller icons, because the table is largest-first and a wheel TOWARDS the
   *  reader makes things smaller, which is the direction every zoom in every program uses.
   *
   *  IT STOPS AT BOTH ENDS RATHER THAN WRAPPING. A slider that jumped from Tiles back to Extra large
   *  on one more notch is a reader's gesture producing the opposite of what it had been producing. */
  const stepView = (by) => {
    const at = VIEWS.findIndex((v) => v.id === view.id);
    const to = Math.max(0, Math.min(VIEWS.length - 1, at + by));
    if (to === at) return false;
    return setView(VIEWS[to].id);
  };

  /**
   * THE NEXT VIEW, WRAPPING — what the button in the address strip does, and the ONE place the
   * button and the slider differ.
   *
   * A BUTTON CYCLES AND A SLIDER CLAMPS, and the asymmetry is the gestures' own. Ctrl+wheel is a
   * continuous slider: wrapping it would make one more notch produce the opposite of what the
   * previous notch produced, which is `stepView`'s stated reason for stopping at both ends. A
   * BUTTON has one direction and no magnitude, so a button that clamped would be a control a
   * reader can press once and then press for ever with no effect — which is what this was: from
   * the Details default it reached Tiles and was INERT thereafter, so a reader with no wheel could
   * never see an icon size at all. Windows 7's own view button cycles.
   */
  const cycleView = () => {
    const at = VIEWS.findIndex((v) => v.id === view.id);
    return setView(VIEWS[(at + 1) % VIEWS.length].id);
  };

  const sortBy = (key) => {
    if (!COLUMNS.some((c) => c.key === key)) return refuse(String(key), "is not a column");
    const was = focus >= 0 && focus < rows.length ? rows[focus] : null;
    sort = sort.chosen && sort.key === key
      ? { key, dir: -sort.dir, chosen: true }
      : { key, dir: 1, chosen: true };
    sortRows(rows);
    account.sort = { ...sort };
    account.sorts += 1;
    account.rows = reportRows();
    selectOnly(-1);
    setFocus(was ? rows.indexOf(was) : -1);
    setLit(-1);
    band = null;
    press = null;
    dragging = false;
    forgetMenu();
    env.std.say(env, `${NAME}: sorted by ${key} `
      + `${sort.dir > 0 ? "ascending" : "descending"}\n`);
    return true;
  };

  const relist = (next, { push = true } = {}) => {
    /* M19: AND THE SORT GOES WITH THEM, which is why the new list is built with the DEFAULT order
     * rather than the one in hand. `files /some/dir` and the same directory navigated into must
     * show the same rows in the same order — a sort that travelled would make row 1 depend on a
     * column the reader chose for a directory that is gone, and nothing on screen would say so.
     * Built before it is committed, like the rows, so a directory that cannot be read leaves both
     * the listing and the sort exactly as they were. */
    const order = { key: SORT_DEFAULT.key, dir: SORT_DEFAULT.dir, chosen: false };
    const built = buildRows(next, order);
    if (typeof built === "number") return refuse(next, env.std.errnoName(built));
    if (push) history.push(dir);
    dir = next;
    /* M23. THE SEARCH GOES WITH THE DIRECTORY, AND THE WALK WITH IT. A query names files in the
     * folder a reader has just left; carrying it into a new one would show them a filtered listing
     * they never asked for and would make an empty directory indistinguishable from a query that
     * matched nothing. A walk in flight is abandoned for the harder version of the same reason: its
     * stack holds paths under the previous root. */
    query = "";
    walk = null;
    walked = "";
    strip = "trail";
    stripDraft = "";
    // THE ACCOUNT IS TOLD, which the first spelling forgot: a typed-path navigation closes the
    // field through these locals, so `account.strip` went on reporting `path` for the rest of the
    // run and a check reading it would believe a field was open that is not.
    account.strip = strip;
    account.stripDraft = "";
    commitRows(built);
    sort = order;
    account.sort = { ...sort };
    account.dir = dir;
    account.rows = reportRows();
    account.history = history.length;
    account.relists += 1;
    scroll = 0;
    account.scroll = 0;
    account.scrollMax = maxScroll();
    selectOnly(-1);
    lit = -1;
    account.lit = -1;
    band = null;
    press = null;
    dragging = false;
    forgetMenu();
    /* M20. AND AN OPEN RENAME GOES WITH THEM, for this function's own stated reason: `editing.row`
     * is an index into the listing being replaced, so a commit afterwards renames whatever landed
     * in that slot. Cleared here rather than guarded at the commit, because a rebuild should be
     * handed a clean slate. */
    editing = null;
    account.renaming = null;
    setFocus(-1);
    /* M23. AND EVERY PICTURE GOES WITH THEM. Each cache entry is keyed by a PATH in the directory
     * that is gone, so none of them can be wanted again — and a live data object nobody will ask
     * for is a `DOBJ_CAP` slot the next directory's thumbnails cannot have, which is a cache that
     * stops working after twenty-eight folders. A rebuild gets a clean slate (CLAUDE.md). */
    dropAllThumbs();
    account.thumbs.ready = 0;
    account.thumbs.wanted = 0;
    account.thumbs.rows = [];
    account.thumbs.bytes = thumbBytes;
    /* M23. AND THE NEW FOLDER'S OWN VIEW MODE IS RESTORED, which is R27's per-folder memory read
     * back. A FOLDER NOBODY HAS SET KEEPS THE MODE THE READER IS IN rather than snapping to
     * Details, which is Explorer's behaviour and the only one that makes sense of a reader who has
     * just chosen Large icons and then opened a subfolder: the choice was about how they want to
     * look at files, not about one directory. The SORT is reset here (above) and the view is not,
     * and that asymmetry is deliberate — a sort names a COLUMN of a listing that is gone, while a
     * view names a size of picture, which is a preference and not a fact about a directory. */
    const remembered = viewByDir.get(dirKey(dir));
    if (remembered && remembered !== view.id) {
      view = VIEW_BY_ID[remembered];
      account.view = view.id;
      account.viewLabel = view.label;
      account.viewFlow = view.flow;
      account.viewAxis = axisOf(view);
    }
    account.lanes = lanesOf(view, FILES_METRICS.viewBox(clientW, clientH)).lanes;
    account.scrollMax = maxScroll();
    // THE TITLE NAMES WHERE THE WINDOW IS, which is the only text outside the surface a reader has
    // and the one thing a driver outside the process can read without decoding a display list.
    env.win.setTitle(made.fd, `${NAME} — ${dir}`);
    env.std.say(env, `${NAME}: ${dir}, ${rows.length} row(s)\n`);
    return true;
  };

  /** Back, which is Alt+Left and Backspace. GOING BACK FROM THE BOTTOM OF THE STACK IS A REFUSAL —
   *  this window was opened on a directory and there is nothing above it that a reader asked for.
   *  The entry is put back if the re-list fails, so a directory deleted under the window does not
   *  silently cost a level. */
  const goBack = () => {
    if (history.length === 0) return refuse(dir, "there is nowhere to go back to");
    const to = history.pop();
    if (!relist(to, { push: false })) {
      history.push(to);
      account.history = history.length;
      return false;
    }
    account.backs += 1;
    return true;
  };

  /**
   * OPEN ROW `i`. A directory re-lists in place; a file spawns the program the association names.
   *
   * THE ASSOCIATION IS `std.openerForPath` AND NOT A TABLE OF THIS PROGRAM'S. It carries the ARGV
   * as well as the program, because `imgview` wants `-f PATH` and `editor` wants a bare path — a
   * caller that guessed would hand one of them the other's operand (`src/libos/std.mjs`).
   *
   * A FILE NOTHING OPENS IS REFUSED BY NAME AND COUNTED. Silently doing nothing is the defect:
   * M14 shipped a desktop icon that launched a program which exited at once, and a reader reported
   * it as an icon that did not work. `openerForPath` answers null rather than defaulting, for the
   * reason recorded there — launching an arbitrary program on unknown bytes shows a reader a binary
   * as text.
   */
  const activate = (i) => {
    if (i < 0) return refuse("no row is focused", "press a row or use the arrow keys first");
    if (i >= rows.length) return refuse(`row ${i + 1}`, "is not in this list");
    const row = rows[i];
    if (row.dir) {
      if (!relist(row.path)) return false;
      account.activations += 1;
      return true;
    }
    const open = env.std.openerForPath(row.path);
    if (!open) return refuse(row.name, "no program in this system opens a file of that type");
    const argv = open.argv(row.path);
    const pid = env.proc.spawn(`${BIN_DIR}/${argv[0]}`, argv);
    if (pid < 0) return refuse(row.name, `spawn ${open.prog}: ${env.std.errnoName(pid)}`);
    account.activations += 1;
    account.spawned.push({ pid, argv });
    env.std.say(env, `${NAME}: ${argv.join(" ")} -> pid ${pid}\n`);
    // NOTHING IN THIS WINDOW CHANGED. The new process draws its own.
    return false;
  };

  /* ---- M20: THE SIX VERBS, EVERY ONE OF THEM A SYSCALL ------------------------------------- */

  /** A child of `base`, by name: exactly one trailing slash, which is `buildRows`' own rule — the
   *  root must not produce `//name`. `base` is a parameter because a DROP may land in a directory
   *  ROW rather than in the open directory. */
  const childIn = (base, name) => `${base.endsWith("/") ? base : `${base}/`}${name}`;
  /** A child of the open directory, by name. */
  const childPath = (name) => childIn(dir, name);

  /**
   * RE-READ THIS DIRECTORY, KEEPING THE SORT AND THE READER'S PLACE IN IT.
   *
   * NOT `relist`, AND THE DIFFERENCE IS WHICH THING CHANGED. `relist` ENTERS a directory, so the
   * sort, the offset, the selection and the cursor all named a listing that is gone and are reset.
   * Here the directory is the same and its CONTENTS moved: the sort stays, the offset stays
   * (re-clamped against the new row count) and the selection is restored BY NAME.
   *
   * BY NAME AND NOT BY INDEX, because index order is exactly what a mutation moves — a `mkdir`
   * inserts a row above every selected one, and a restored index would highlight the wrong file.
   * `sortBy` carries the cursor by identity for the same reason.
   *
   * THE LISTING IS BUILT BEFORE ANYTHING IS COMMITTED, like `relist`'s: a directory that cannot be
   * re-read leaves the window exactly as it was, with the refusal named.
   */
  const reread = (select = []) => {
    const built = buildRows(dir, sort);
    if (typeof built === "number") return refuse(dir, env.std.errnoName(built), built);
    /* M23. THROUGH `commitRows`, SO A RE-READ KEEPS THE READER'S QUERY. A verb that re-listed the
     * whole directory under an open search would answer a reader's Delete by showing them every
     * file they had just filtered away. */
    commitRows(built);
    account.rows = reportRows();
    const wanted = new Set(select);
    sel = new Set();
    rows.forEach((r, i) => { if (wanted.has(r.name)) sel.add(i); });
    anchor = sel.size > 0 ? Math.min(...sel) : -1;
    reportSelection();
    setFocus(anchor);
    setLit(-1);
    band = null;
    press = null;
    dragging = false;
    /* AN EDIT DOES NOT SURVIVE A RE-READ. `editing.row` is an index into the listing that was just
     * replaced, so committing afterwards would rename whatever landed in that slot. */
    editing = null;
    account.renaming = null;
    forgetMenu();
    const limit = maxScroll();
    // `--unclamped-scroll` REACHES HERE for `relayout`'s reason: this is the same end clamp at a
    // different moment, and gating only one of the three leaves a control a verb silently undoes.
    if (scroll > limit && !unclampedScroll) scroll = limit;
    account.scroll = scroll;
    account.scrollMax = limit;
    if (anchor >= 0) revealRow(anchor);
    return true;
  };

  /**
   * THE ROWS A VERB ACTS ON, in LAYOUT order: the selection if there is one, else the cursor's row,
   * else nothing.
   *
   * ONE DEFINITION, because Delete, Cut and Copy must take the same set. A Copy that read the
   * selection and a Delete that read the cursor would remove a file the reader had not copied, and
   * the two gestures look identical from outside.
   */
  const targetRows = () => {
    if (sel.size > 0) return [...sel].sort((a, b) => a - b).filter((i) => i < rows.length);
    return focus >= 0 && focus < rows.length ? [focus] : [];
  };

  /** A name nothing in this listing has — `freeFrom` over the rows in hand. THE SET IS THIS
   *  LISTING'S, so a name created under the window since the last read is not seen and `mkdir`
   *  answers EEXIST: a guess from a stale listing must be refused by name rather than retried,
   *  because the retry loop cannot tell a collision from a full disk. */
  const freeName = (stem) => freeFrom(new Set(rows.map((r) => r.name)), stem);

  /* ---- M21: THE BIN'S FOUR OPERATIONS ------------------------------------------------------- */

  /**
   * THE BIN EXISTS, OR THE ERRNO THAT SAYS WHY NOT. Made on the first delete that needs it and not
   * at startup: a window that created a directory in a reader's tree merely by being opened would
   * put a row on the desktop nobody asked for.
   *
   * A NON-DIRECTORY AT THE PATH IS ENOTDIR AND NOT AN `mkdir` — `mkdir` would answer EEXIST, which
   * reads as "the Bin is there" and is the opposite of what a reader needs to be told.
   */
  const ensureBin = () => {
    const st = env.fs.lstat(binRoot);
    if (typeof st !== "number") {
      return (st.mode & S_IFMT) === S_IFDIR ? 0 : -ENOTDIR;
    }
    const rc = env.fs.mkdir(binRoot, 0o700);
    return rc < 0 && rc !== -EEXIST ? rc : 0;
  };

  /** Every name the Bin holds, payloads AND origin records, or a negative errno. READ ONCE PER
   *  GESTURE and grown locally as each name is taken: a delete of five rows must not pay five
   *  `readdir`s, and two rows of one name in one gesture must not pick the same payload name. */
  const binTaken = () => {
    const entries = env.std.listDir(env, binRoot);
    if (typeof entries === "number") return entries;
    return new Set(entries.map((e) => e.name));
  };

  /**
   * MOVE ONE ROW INTO THE BIN. Answers the payload's name, or `""` with the refusal already named.
   *
   * THE ORIGIN RECORD IS WRITTEN FIRST AND THE BYTES MOVE SECOND, which is a JUDGEMENT and is the
   * only one of the two orders that is: both are recoverable, measured, and this one's half-state
   * is a record naming a file that is still where the reader left it — nothing on screen is wrong
   * and nothing is unreachable. The other order's half-state is a Bin row whose Restore has to
   * refuse by name (`bench/m21-bin/probe.mjs`: 1,260 stranded records against 1,125 unrestorable
   * rows).
   *
   * THE RECORD IS TAKEN BACK WHEN THE RENAME IS REFUSED, and that is an ERROR PATH rather than a
   * tear: the call answered in front of us, so a record for a payload that never moved is garbage
   * this process can still name. A TORN delete cannot reach here, and what it leaves is counted.
   *
   * AND IT IS THE RECORD THAT CLAIMS THE NAME, which is what makes two `files` windows deleting one
   * name at the same moment safe without a lock: `taken` is a listing read before the gesture, so
   * both may choose `x` — and `symlink` is `O_EXCL`-shaped, so the second one is refused EEXIST
   * BEFORE any bytes move. Payload-first would have the two `rename`s race over one destination,
   * which `vfs.rename` resolves by clobbering.
   */
  const binOne = (row, taken) => {
    const name = freeFrom(taken, row.name, (c) => `${c}${ORIGIN_SUFFIX}`);
    if (name === null) {
      refuse(row.name, "the Bin already holds 1000 rows of this name");
      return "";
    }
    const payload = `${binRoot}/${name}`;
    const record = originRecordOf(payload);
    const link = env.fs.symlink(row.path, record);
    if (link < 0) {
      refuse(row.name, `symlink ${record}: ${env.std.errnoName(link)}`, link);
      return "";
    }
    const rc = env.fs.rename(row.path, payload);
    if (rc < 0) {
      if (env.fs.unlink(record) < 0) account.bin.stranded += 1;
      refuse(row.name, `rename into the Bin: ${env.std.errnoName(rc)}`, rc);
      return "";
    }
    taken.add(name);
    taken.add(name + ORIGIN_SUFFIX);
    account.bin.binned.push({ name, from: row.path, payload });
    return name;
  };

  /**
   * PUT ONE BIN ROW BACK WHERE ITS RECORD SAYS IT CAME FROM.
   *
   * THE ORDER IS FORCED AND IT IS THE OPPOSITE OF THE DELETE'S: the bytes go home FIRST and the
   * record is dropped SECOND. The other order left 1,260 of 2,017 torn cases with bytes in the Bin
   * that nothing names, and the fact needed to repair that is the fact that was lost — the only
   * irreversible half-state the measurement found.
   *
   * THE OCCUPIED-PATH REFUSAL IS THIS PROGRAM'S BECAUSE THE FILESYSTEM HAS NONE. `vfs.rename` has
   * no `RENAME_NOREPLACE` and over a plain file refuses nothing: `applyOp`'s RENAME arm deletes the
   * standing entry, decrements nlink and FREES the inode, in one journal record. So the `lstat` is
   * the only test there is, and it races — the same trade `commitRename` states, and the lesser
   * fault against destroying a file the reader made in the meantime.
   */
  const restoreOne = (row) => {
    const record = originRecordOf(row.path);
    const origin = env.fs.readlink(record);
    if (typeof origin !== "string") {
      refuse(row.name, `readlink ${record}: ${env.std.errnoName(origin)}`, origin);
      return false;
    }
    /* `--restore-overwrites` IS EXACTLY THIS TEST GONE, which is the one world in which a restore
     * destroys a file a reader created after the delete. */
    if (!restoreOverwrites && typeof env.fs.lstat(origin) !== "number") {
      refuse(row.name, `${origin} is already here; a restore does not replace a file`, EEXIST);
      return false;
    }
    const rc = env.fs.rename(row.path, origin);
    if (rc < 0) {
      refuse(row.name, `rename to ${origin}: ${env.std.errnoName(rc)}`, rc);
      return false;
    }
    // THE RECORD GOES SECOND AND ITS REFUSAL IS NOT THE RESTORE'S. The bytes are home; a record
    // left behind names a path that is occupied by the file it describes, which `buildRows` counts
    // as stranded and no row is drawn for.
    if (env.fs.unlink(record) < 0) account.bin.stranded += 1;
    account.bin.restored.push({ name: row.name, to: origin });
    return true;
  };

  /** ONE PATH INTO THE BIN, with the directory ensured and its names read for this call alone —
   *  the single-row form the drag's own MOVE completion needs, where there is no selection and no
   *  listing to read from. `deleteSelection` reads the names ONCE for a whole set instead, which is
   *  the only reason that loop does not come through here. */
  const binPathOnce = (name, path) => {
    const ready = ensureBin();
    if (ready < 0) return refuse(binRoot, `mkdir: ${env.std.errnoName(ready)}`, ready);
    const taken = binTaken();
    if (typeof taken === "number") {
      return refuse(binRoot, `readdir: ${env.std.errnoName(taken)}`, taken);
    }
    return binOne({ name, path }, taken) !== "";
  };

  /** NEW FOLDER: one `mkdir`, then a fresh `readdir` — so the row a reader sees came back out of
   *  the filesystem and not out of this program's belief about its own call. The created row is
   *  selected and focused and is NOT put straight into a rename box: the two verbs stay separate so
   *  each can be driven without the other, and F2 is the next gesture. */
  const newFolder = () => {
    const name = freeName(NEW_FOLDER_STEM);
    if (name === null) {
      return refuse(NEW_FOLDER_STEM, "there are already 1000 folders of this name here");
    }
    const rc = env.fs.mkdir(childPath(name));
    if (rc < 0) return refuse(name, `mkdir: ${env.std.errnoName(rc)}`, rc);
    account.created.push(name);
    env.std.say(env, `${NAME}: mkdir ${childPath(name)}\n`);
    reread([name]);
    return true;
  };

  /** BEGIN A RENAME ON ROW `i`. The draft opens holding the name that is there, which is what makes
   *  a one-character correction one keystroke rather than a retype. */
  const beginRename = (i) => {
    if (i < 0 || i >= rows.length) {
      return refuse("no row is focused", "press a row or use the arrow keys first");
    }
    if (editing) return refuse(rows[i].name, "a rename is already open on this list");
    editing = { row: i, was: rows[i].name, draft: rows[i].name };
    account.renaming = { row: i, was: editing.was, draft: editing.draft };
    env.std.say(env, `${NAME}: renaming ${editing.was}; Enter commits, Esc cancels\n`);
    return revealRow(i) || true;
  };

  /** ABANDON THE EDIT. The file is untouched and the refusal is NOT counted: a reader who changed
   *  their mind asked for nothing and was declined nothing. */
  const cancelRename = () => {
    if (!editing) return false;
    env.std.say(env, `${NAME}: rename of ${editing.was} cancelled\n`);
    editing = null;
    account.renaming = null;
    return true;
  };

  /**
   * COMMIT THE EDIT: one `rename`, then a fresh `readdir` with the new name selected.
   *
   * THE EDIT IS CLOSED BEFORE THE CALL, whatever happens. A refused rename that left the box open
   * would leave a reader typing into a field whose last attempt they have already been told about,
   * and the refusal names the file either way.
   *
   * AN UNCHANGED NAME PAYS NO CALL. `rename(a, a)` is a no-op in POSIX and in this VFS, but it also
   * journals an op and stamps a time, and a reader who opened the box and pressed Enter changed
   * nothing.
   *
   * THE DESTINATION IS CHECKED HERE AND THE RACE IS STATED. `rename(2)` REPLACES an occupied
   * destination by contract (`src/fs/vfs.mjs`), so there is no flag that makes the kernel refuse —
   * which means a file manager's only place to refuse is before the call, and between the `lstat`
   * and the `rename` another process may create the name. The alternative is silently destroying a
   * reader's file, so the race is the lesser fault and is written down rather than hidden.
   */
  const commitRename = () => {
    if (!editing) return false;
    const { was, draft } = editing;
    editing = null;
    account.renaming = null;
    if (draft === was) {
      env.std.say(env, `${NAME}: ${was} is unchanged\n`);
      return true;
    }
    const fault = nameFault(draft);
    if (fault) return refuse(draft, fault) || true;
    const to = childPath(draft);
    if (typeof env.fs.lstat(to) !== "number") {
      refuse(draft, "is already here; a rename does not replace a file", EEXIST);
      return true;
    }
    const rc = env.fs.rename(childPath(was), to);
    if (rc < 0) {
      refuse(was, `rename: ${env.std.errnoName(rc)}`, rc);
      return true;
    }
    account.renamed.push({ from: was, to: draft });
    account.renames += 1;
    env.std.say(env, `${NAME}: ${was} -> ${draft}\n`);
    reread([draft]);
    return true;
  };

  /**
   * DELETE: TO THE BIN where there is one, and `unlink`/`rmdir` where there is not.
   *
   * WHICH IT IS, IS THE PATH'S AND NOT THE READER'S. A row inside the session tree goes to the Bin
   * — a folder with things in it included, because a `rename` relocates a whole subtree in one call
   * and nothing is destroyed, so M20's "recursing on a folder somebody selected by accident is the
   * worst outcome available" no longer describes what happens. A row OUTSIDE it is removed: the Bin
   * is `std.HOME_DIR`'s, a cross-volume `rename` is not a thing the filesystem does, and a second
   * Bin per mount would be a second place to look for a file. So `/usr/share` still answers EROFS
   * by name and `/tmp` is still final — and a non-empty folder there still answers ENOTEMPTY,
   * because that is `rmdir` speaking.
   *
   * A ROW ALREADY IN THE BIN IS REMOVED, which is Windows' rule and is how a reader empties it:
   * select the rows and press Delete. The Bin recycling its own rows would be a delete nobody could
   * ever finish.
   *
   * THE WHOLE SET IS ATTEMPTED AND EVERY OUTCOME IS NAMED, rather than stopping at the first
   * refusal: five selected files of which one is refused must delete four and say which one they
   * would not. A BIN THAT CANNOT BE REACHED IS SAID ONCE and the rest of the set is left alone — a
   * delete that silently became permanent because a `mkdir` failed is the worst reading available.
   */
  const deleteSelection = () => {
    const targets = targetRows();
    if (targets.length === 0) {
      return refuse("no row is selected", "press a row or use the arrow keys first");
    }
    let taken = null;
    let binWhy = "";
    let gone = 0;
    let binned = 0;
    for (const i of targets) {
      const row = rows[i];
      if (binnable(row.path)) {
        if (binWhy) continue;
        if (taken === null) {
          const made = ensureBin();
          if (made < 0) {
            binWhy = env.std.errnoName(made);
            refuse(binRoot, `mkdir: ${binWhy}`, made);
            continue;
          }
          const names = binTaken();
          if (typeof names === "number") {
            binWhy = env.std.errnoName(names);
            refuse(binRoot, `readdir: ${binWhy}`, names);
            continue;
          }
          taken = names;
        }
        if (binOne(row, taken) === "") continue;
        gone += 1;
        binned += 1;
        account.deleted.push(row.name);
        continue;
      }
      const rc = row.dir ? env.fs.rmdir(row.path) : env.fs.unlink(row.path);
      if (rc < 0) {
        refuse(row.name, `${row.dir ? "rmdir" : "unlink"}: ${env.std.errnoName(rc)}`, rc);
        continue;
      }
      gone += 1;
      account.bin.permanent += 1;
      account.deleted.push(row.name);
    }
    env.std.say(env, `${NAME}: deleted ${gone} of ${targets.length}: ${binned} to the Bin, `
      + `${gone - binned} permanently\n`);
    reread([]);
    return true;
  };

  /**
   * RESTORE: every target row back to the path its origin record names.
   *
   * A VERB OF THE BIN AND NOWHERE ELSE, refused by name elsewhere rather than absent: a row menu
   * outside the Bin does not carry it, and a report against one that did would be acting on a list
   * this window never published.
   */
  const restoreSelection = () => {
    if (!inBin()) {
      return refuse("restore", `is a verb of ${binRoot}, and this window is looking at ${dir}`);
    }
    const targets = targetRows();
    if (targets.length === 0) {
      return refuse("no row is selected", "press a row or use the arrow keys first");
    }
    let back = 0;
    for (const i of targets) if (restoreOne(rows[i])) back += 1;
    env.std.say(env, `${NAME}: restored ${back} of ${targets.length}\n`);
    reread([]);
    return true;
  };

  /**
   * F5: RE-LIST, AND THE SELECTION SURVIVES FOR THE ROWS THAT SURVIVE.
   *
   * IT IS `reread`, which already restores a selection BY NAME — and by name rather than by index
   * is the whole of the clause: index order is exactly what a mutation under the window moves, so a
   * restored index would highlight whatever landed in the slot. A name that is gone is simply not
   * re-selected: it must not resurrect a row and must not be indexed into a shorter list.
   *
   * `--stale-listing` SERVES THE ROWS ALREADY IN HAND. The keysym still arrives and is still
   * counted, so what the control moves is what the window SHOWS and not whether F5 was delivered.
   */
  const refresh = () => {
    account.refreshes += 1;
    const wanted = [...sel].filter((i) => i < rows.length).map((i) => rows[i].name);
    if (staleListing) {
      account.refreshKept = wanted.length;
      env.std.say(env, `${NAME}: --stale-listing, serving the ${rows.length} row(s) in hand\n`);
      return true;
    }
    if (!reread(wanted)) return false;
    account.refreshKept = sel.size;
    env.std.say(env, `${NAME}: re-listed ${dir}, ${rows.length} row(s), ${sel.size} of `
      + `${wanted.length} selected row(s) survived\n`);
    return true;
  };

  /**
   * PUBLISH THE TARGET ROWS' PATHS TO THE ONE CLIPBOARD, as `DOBJ_PATHS`.
   *
   * NUL-SEPARATED AND ABSOLUTE, which is the format's own definition in `src/abi.mjs` and what
   * `src/bin/clip.mjs` already writes — so `clip paste` reads back what this put there and neither
   * side carries a second encoding. A row's `path` is absolute already: `buildRows` built it from
   * the directory it listed.
   *
   * THE FD IS CLOSED AT ONCE AND THE OBJECT STAYS. The clipboard holds the kernel's own reference,
   * which is the whole of "copy, close the window, paste" (constraint 241).
   *
   * WHAT THE KERNEL GRANTED IS WHAT IS WRITTEN, never what was asked for: `dataobj_create` settles
   * the offer and may narrow it, and a program writing from its own list would be refused -ENOTSUP
   * for a format it never held (`src/bin/clip.mjs` states the same rule).
   *
   * THE INTENT IS NOT WRITTEN INTO THE OBJECT, and cannot be: a published object is SEALED and
   * `dataobj_set` answers -EPERM by design (constraint 242), and the record carries no cut/copy
   * field. So a Cut records its intent in `clip` and a Cut pasted by another process is a copy.
   */
  const toClipboard = (intent) => {
    const targets = targetRows();
    if (targets.length === 0) {
      return refuse("no row is selected", "press a row or use the arrow keys first");
    }
    const paths = targets.map((i) => rows[i].path);
    const object = env.data.create([DOBJ_PATHS]);
    if (typeof object === "number") {
      return refuse(intent, `dataobj_create: ${env.std.errnoName(object)}`, object);
    }
    try {
      const granted = fmtsOf(object.offer);
      if (!granted.includes(DOBJ_PATHS)) {
        return refuse(intent, `the kernel granted only ${granted.map(fmtName).join(", ")}, `
          + "and a file list has nowhere to go");
      }
      const list = env.std.bytes(paths.join("\0"));
      const set = env.data.set(object.fd, DOBJ_PATHS, list);
      if (set < 0) return refuse(intent, `dataobj_set paths: ${env.std.errnoName(set)}`, set);
      const put = env.data.toClipboard(object.fd);
      if (put < 0) return refuse(intent, `dataobj_offer: ${env.std.errnoName(put)}`, put);
      // THE SET IS WHAT `paint` READS to dim a cut row, kept beside the array so the drawing is a
      // membership test rather than a scan per row per frame.
      clip = { intent, paths, marked: new Set(paths) };
      account.clipboard = { intent, paths: [...paths] };
      if (intent === V_CUT) account.cuts += 1; else account.copies += 1;
      env.std.say(env, `${NAME}: ${intent} ${paths.length} path(s) to the clipboard\n`);
      return true;
    } finally {
      env.fs.close(object.fd);
    }
  };

  /**
   * BRING ONE PATH INTO `into`: a `rename` for a move, the bytes for a copy. Answers the name it
   * landed under, or `""` with the refusal already named.
   *
   * ONE DEFINITION, BECAUSE A PASTE AND A DROP ARE THE SAME LANDING REACHED BY TWO GESTURES. Two
   * copies is how one of them comes to replace a file the other refuses to — and `--paste-clobbers`
   * reaches both for the same reason: whether a landing may destroy a file the reader can see is
   * ONE decision.
   *
   * AN OCCUPIED NAME IS REFUSED, AND THE TWO HALVES REFUSE DIFFERENTLY. A copy opens with
   * `O_CREAT | O_EXCL` and the KERNEL answers EEXIST, with no window between a test and a create. A
   * move cannot be written that way — `rename(2)` replaces its destination by contract — so its
   * only test is an `lstat` first, which races; `commitRename` states the same trade.
   *
   * A DIRECTORY IS MOVED AND NOT COPIED. `rename` relocates a whole subtree in one call; copying
   * one needs a recursive walk, which is a verb of its own — and a directory copied as an empty
   * directory is worse than a refusal, so the refusal is by name.
   *
   * THE MODE TRAVELS WITH A COPY. `/usr/bin` holds 32 executables and a pasted program that lost
   * its execute bit is a program that no longer runs, which nothing on screen would explain.
   */
  const landOne = (from, into, { moving, gesture }) => {
    const name = baseNameOf(from);
    const to = childIn(into, name);
    if (to === from) {
      refuse(name, "is already in this directory");
      return "";
    }
    /* `--paste-clobbers` REMOVES THIS AND THE `O_EXCL` BELOW, which is one control over one
     * decision: whether a landing may destroy a file the reader can see. */
    if (!pasteClobbers && typeof env.fs.lstat(to) !== "number") {
      refuse(name, `is already here; ${gesture} does not replace a file`, EEXIST);
      return "";
    }
    const st = env.fs.lstat(from);
    if (typeof st === "number") {
      refuse(name, `lstat: ${env.std.errnoName(st)}`, st);
      return "";
    }
    if (moving) {
      const rc = env.fs.rename(from, to);
      if (rc < 0) {
        refuse(name, `rename: ${env.std.errnoName(rc)}`, rc);
        return "";
      }
      return name;
    }
    if ((st.mode & S_IFMT) === S_IFDIR) {
      refuse(name, "is a directory, and copying one is not a verb this window has; cut it to move it");
      return "";
    }
    const body = readFile(env, from);
    if (typeof body === "number") {
      refuse(name, `read: ${env.std.errnoName(body)}`, body);
      return "";
    }
    const flags = O_WRONLY | O_CREAT | (pasteClobbers ? 0 : O_EXCL);
    const fd = env.fs.open(to, flags, st.mode & 0o777);
    if (fd < 0) {
      refuse(name, `open: ${env.std.errnoName(fd)}`, fd);
      return "";
    }
    // `env.fs.write` IS LAYER 2 AND CONSUMES SHORT COUNTS (`src/libos/syscall.mjs`), so a 300 KiB
    // file is one call here and several on the channel.
    const wrote = env.fs.write(fd, body);
    env.fs.close(fd);
    if (wrote < 0) {
      refuse(name, `write: ${env.std.errnoName(wrote)}`, wrote);
      return "";
    }
    return name;
  };

  /**
   * PASTE: read the clipboard's path list and bring each entry here — `rename` for a cut, bytes for
   * a copy.
   *
   * THE PATHS COME OUT OF THE KERNEL'S OBJECT AND NOT OUT OF `clip`. The local record says only what
   * the INTENT was; reading the list from this program's own copy would paste a stale selection
   * after another process replaced the clipboard, and `clip copy /some/file` at a prompt must paste
   * here.
   *
   * WHAT ONE PATH'S LANDING IS, is `landOne` — the same function a DROP lands through, so the two
   * gestures cannot come to disagree about an occupied name.
   *
   * A CUT IS SPENT BY THE PASTE THAT MOVES IT. The source is gone, so a second paste of the same
   * list would refuse ENOENT once per row; clearing the intent leaves the clipboard holding paths
   * that name nothing, which is the state `clip list` already reports honestly.
   */
  const paste = () => {
    const opened = env.data.open(DOBJ_WHERE_CLIPBOARD);
    if (typeof opened === "number") {
      return refuse("the clipboard", `dataobj_open: ${env.std.errnoName(opened)}`, opened);
    }
    let list = [];
    try {
      const offered = fmtsOf(opened.offer);
      if (!offered.includes(DOBJ_PATHS)) {
        return refuse("the clipboard",
          `holds ${offered.map(fmtName).join(", ")} and no path list`);
      }
      const got = env.data.get(opened.fd, DOBJ_PATHS);
      if (typeof got === "number") {
        return refuse("the clipboard", `dataobj_get paths: ${env.std.errnoName(got)}`, got);
      }
      list = env.std.text(got).split("\0").filter((p) => p !== "");
    } finally {
      env.fs.close(opened.fd);
    }
    if (list.length === 0) return refuse("the clipboard", "holds an empty path list");
    const moving = !!clip && clip.intent === V_CUT;
    const landed = [];
    for (const from of list) {
      const name = landOne(from, dir, { moving, gesture: "a paste" });
      if (name !== "") landed.push(name);
    }
    account.pastes += 1;
    for (const name of landed) account.pasted.push({ name, moved: moving });
    env.std.say(env, `${NAME}: pasted ${landed.length} of ${list.length} `
      + `as a ${moving ? "move" : "copy"}\n`);
    if (moving && landed.length > 0) {
      clip = null;
      account.clipboard = null;
    }
    reread(landed);
    return true;
  };

  /** ONE VERB, BY NAME. The ONE place a menu row and a key chord meet: a context menu's Delete and
   *  the Delete key must do the same thing, and two call sites is how they come to differ. */
  const runVerb = (verb, target) => {
    if (verb === V_OPEN) return activate(target);
    if (verb === V_NEW_FOLDER) return newFolder();
    if (verb === V_RENAME) return beginRename(target);
    if (verb === V_DELETE) return deleteSelection();
    if (verb === V_CUT) return toClipboard(V_CUT);
    if (verb === V_COPY) return toClipboard(V_COPY);
    if (verb === V_PASTE) return paste();
    if (verb === V_RESTORE) return restoreSelection();
    return refuse(String(verb) || "a separator", "is not a verb this window has");
  };

  /* ---- M20: THE TWO MENUS -------------------------------------------------------------------- */

  /** Whether the clipboard has anything to paste, so Paste can be drawn DISABLED rather than
   *  live-and-silent — Windows 7's own rule for an inapplicable command, and this project's for a
   *  caption button. It costs one `dataobj_open` per right-click, which is what asking the one
   *  authority rather than trusting a local flag costs: another process may have replaced the
   *  clipboard since this one wrote it. */
  const clipboardHasPaths = () => {
    const opened = env.data.open(DOBJ_WHERE_CLIPBOARD);
    if (typeof opened === "number") return false;
    const has = fmtsOf(opened.offer).includes(DOBJ_PATHS);
    env.fs.close(opened.fd);
    return has;
  };

  /**
   * THE TWO MENUS, AS ROWS. One for a row and one for empty space, and which is built is decided by
   * `rowUnder` at the press — the same arbitration the drag and the band already take there, taken
   * once (this file's header).
   *
   * EVERY ROW CARRIES `WITEM_CONTEXT`, which the kernel does not require: `WEV_ITEM`'s `c` reports
   * where the pick came from independently. It is set because the flags are the publisher's
   * statement about its own rows, and a row that said nothing about where it belongs would be a row
   * `/proc` could not describe.
   */
  const rowMenuFor = (i) => {
    const row = rows[i];
    const count = sel.size > 0 ? sel.size : 1;
    /* M21. RESTORE IS A ROW OF THE BIN'S MENU AND OF NO OTHER, which is why it is prepended here
     * rather than carried disabled everywhere: a command that cannot apply in any directory but
     * one is noise, and `src/bin/desktop.mjs`'s rule for a row a reader cannot use is that it is
     * not published. It is DISABLED for a payload whose origin record is gone — there is no
     * destination to name, and a live row that refused would be a reader told nothing until after
     * they pressed it. */
    const restore = inBin()
      ? [{ verb: V_RESTORE, icon: WICON_TRASH,
        label: count > 1 ? `Restore ${count} items` : "Restore",
        flags: row.origin ? 0 : WITEM_DISABLED }, MENU_RULE]
      : [];
    return [
      ...restore,
      /* THE ROW'S OWN ICON COMES FROM `std.iconForPath`, which is userland's ONE table of which
       * picture a file gets (`src/libos/std.mjs`) — the same one the desktop's rows read, so a
       * `.txt` in this menu and a `.txt` on the desktop are the same drawing. */
      { verb: V_OPEN,
        icon: env.std.iconForPath(row.path, { isDir: row.dir, isProgram: row.exec }),
        label: "Open",
        flags: row.dir ? WITEM_CONTAINER : 0 },
      MENU_RULE,
      { verb: V_CUT, icon: WICON_GENERIC, label: "Cut" },
      { verb: V_COPY, icon: WICON_GENERIC, label: "Copy" },
      MENU_RULE,
      /* M21. THE LABEL IS STILL `Delete` WHERE THE DELETE IS FINAL, which is Windows' own wording:
       * the word does not change, the confirmation does — and this window has no dialog to carry
       * one. What a reader is told instead is where the bytes went, after the fact and by name, on
       * the line `deleteSelection` prints. */
      { verb: V_DELETE, icon: WICON_TRASH,
        label: count > 1 ? `Delete ${count} items` : "Delete" },
      /* RENAME IS DISABLED FOR A MULTIPLE SELECTION, because there is one text box and `rename`
       * takes one pair of paths. A live row that renamed only the first of five is the defect. */
      { verb: V_RENAME, icon: WICON_GENERIC, label: "Rename",
        flags: count > 1 ? WITEM_DISABLED : 0 },
    ];
  };

  const emptyMenuRows = () => [
    { verb: V_NEW_FOLDER, icon: WICON_FOLDER, label: "New folder" },
    MENU_RULE,
    { verb: V_PASTE, icon: WICON_GENERIC, label: "Paste",
      flags: clipboardHasPaths() ? 0 : WITEM_DISABLED },
  ];

  /**
   * RAISE A MENU AT A CSS-PX POINT. `win_menu` takes SURFACE px, so `px` converts — the one
   * multiplication by `S` in this program, used here exactly as the display list uses it. The
   * KERNEL bounds neither coordinate and must not: the page converts with `Surface.clientAt` and
   * clamps the popup, because only it knows where the frame sits on the desktop.
   *
   * THE ROWS SENT ARE THE ABI'S THREE FIELDS AND NOT THIS PROGRAM'S RECORDS. `verb` stays here: the
   * kernel carries a label and an icon id and knows nothing about what a row means, which is the
   * same division `win_items` makes.
   *
   * IT ANSWERS WHETHER A REPAINT IS OWED, which is true only under `--menu-in-surface`. The real
   * menu is a popup in the page's DOM and this program draws nothing for it, so a successful raise
   * changes no pixel of the surface.
   */
  const raiseMenu = (built, atCss, target) => {
    const rows2 = built.map((r) => ({
      icon: r.icon | 0, flags: (r.flags | 0) | WITEM_CONTEXT, label: String(r.label),
    }));
    if (menuInSurface) {
      /* `--menu-in-surface`: THE WORLD WHERE A PROCESS DRAWS ITS OWN POPUP. No `win_menu` reaches
       * the kernel, so `account.menus` stays 0 — and the drawing is bounded by `.window-body`'s
       * `overflow: hidden`, which is the clause this control is here to break. */
      menu = { rows: built, target, at: atCss };
      account.menuInSurfaceAt = { x: atCss.x, y: atCss.y };
      account.menuRows = built.map((r) => r.label);
      account.menuTarget = target;
      return true;
    }
    const rc = env.win.menu(made.fd, px(atCss.x), px(atCss.y), rows2);
    if (rc < 0) {
      account.refusedMenus += 1;
      return refuse("a context menu", `win_menu: ${env.std.errnoName(rc)}`, rc);
    }
    menu = { rows: built, target, at: atCss };
    account.menus += 1;
    account.menuRows = built.map((r) => r.label);
    account.menuTarget = target;
    env.std.say(env, `${NAME}: a ${rc}-row menu on `
      + `${target < 0 ? "empty space" : rows[target].name}\n`);
    return false;
  };

  env.std.say(env, `${NAME}: win ${made.win}, ${rows.length} row(s) in ${dir}\n`);
  rows.forEach((r, i) => env.std.say(env, `  row ${i + 1}  ${r.name}\t${kindOf(r)}\n`));
  env.std.say(env, "press a row and drag it onto another window. the wheel scrolls. "
    + "arrows move, Enter or a double-click opens, Backspace goes back. q quits.\n");
  env.std.say(env, "click a column header to sort, again to reverse. shift or ctrl extend the "
    + "selection; drag from empty space to band-select.\n");
  env.std.say(env, `ctrl+wheel steps the view: ${VIEWS.map((v) => v.label).join(" / ")}. `
    + `--view ID opens in one (${VIEWS.map((v) => v.id).join(", ")}). thumbnails are drawn in `
    + `${VIEWS.filter((v) => v.thumbs).map((v) => v.label).join(", ")}; the other modes draw the `
    + "type icon, which is also the fallback for a file nothing here decodes. a folder remembers "
    + "the mode it was last looked at in, for as long as this window is open.\n");
  env.std.say(env, "the address strip: click a crumb to go there, the empty strip (or alt-D) to "
    + "type a path, the box at the right (or ctrl-F) to search. a query filters THIS directory as "
    + "you type and costs no syscall; Enter walks everything BELOW it by NAME — not by contents — "
    + `to depth ${SEARCH_MAX_DEPTH} and ${SEARCH_MAX_ENTRIES} entries, one readdir per directory `
    + "and one lstat per MATCH. esc or a press outside the strip closes the field. the button at "
    + "the far right CYCLES the view; ctrl+wheel steps it and stops at both ends.\n");
  env.std.say(env, "right-click for a menu. F2 renames, Delete removes, ctrl-N makes a folder, "
    + "ctrl-X/C/V cut, copy and paste. F5 re-lists and keeps the selection.\n");
  env.std.say(env, `a delete inside ${env.std.HOME_DIR} goes to ${binRoot}, where Restore puts it `
    + "back; anywhere else it is permanent. drop files on this window to copy them in; "
    + "ctrl-drag out copies, a plain drag out moves.\n");

  /**
   * WHAT EFFECT A DRAG OF `row` OFFERS, under the modifiers the gesture is being made with.
   *
   * CTRL FORCES A COPY, which is Windows' own binding and the only explicit one a reader has here.
   * Without it a row INSIDE THE SESSION TREE offers a MOVE and a row outside it still offers a
   * COPY, and that asymmetry is the Bin's: the kernel reports an effect for a drop that QUEUED and
   * not for one the target COLLECTED (constraint 245), so a MOVE source cannot verify the
   * collection — the original goes TO THE BIN rather than to `unlink`, and the Bin is the session
   * tree's. No Bin, no safe move. It is also why `files /usr/share` reports COPY for a plain drag:
   * a move off a read-only mount is not a thing this program could complete, and offering one would
   * be a promise the receipt cannot keep.
   *
   * A MOVE IS OFFERED ALONE AND NEVER AS `COPY | MOVE`, because the kernel picks COPY whenever the
   * mask holds it (`src/kernel/dataobj.mjs`): a mask with both is a copy with extra words.
   */
  const effectFor = (row, mods) => {
    if (moveForcedCopy || (mods & WMOD_CTRL)) return DOBJ_EFFECT_COPY;
    return binnable(row.path) ? DOBJ_EFFECT_MOVE : DOBJ_EFFECT_COPY;
  };

  /** Publish one row as a drag. The object's fd is CLOSED immediately and on purpose: the session
   *  holds the kernel's own reference, so the payload outlives this program's handle on it — and
   *  outlives this program (constraint 241). */
  const startDrag = (i, mods = 0) => {
    const row = rows[i];
    /* A DIRECTORY AND AN UNKNOWN FORMAT ARE REFUSED HERE, by name and counted: there are no bytes
     * to offer for either, and a drag that published a path under TEXT would be the guess a typed
     * clipboard exists to refuse. */
    if (row.dir || row.format === 0) {
      account.refusedDrags += 1;
      account.why = `${row.name}: ${row.dir ? "a directory" : "an unknown format"} has no bytes `
        + "to offer";
      return -EINVAL;
    }
    const body = readFile(env, row.path);
    if (typeof body === "number") {
      account.why = `${row.path}: ${env.std.errnoName(body)}`;
      return body;
    }
    const made2 = env.data.create([DOBJ_PATHS, row.format]);
    if (typeof made2 === "number") {
      account.refusedDrags += 1;
      return made2;
    }
    try {
      /* WRITE WHAT THE KERNEL GRANTED, NOT WHAT WAS ASKED FOR. `dataobj_create` returns the offer
       * it settled on and it may be narrower — M10's own control forces TEXT alone — so a program
       * that wrote from its own list would be refused -ENOTSUP for a format it never held and
       * would abandon a gesture that was perfectly able to run. The GESTURE is not the TYPE: under
       * that control this drag still happens and the receiver refuses it by name, which is the
       * failure the control is about. */
      const granted = fmtsOf(made2.offer);
      account.granted = granted.map(fmtName);
      if (granted.includes(DOBJ_PATHS)) {
        const p = env.data.set(made2.fd, DOBJ_PATHS, env.std.bytes(row.path));
        if (p < 0) { account.refusedDrags += 1; return p; }
      }
      if (granted.includes(row.format)) {
        const b = env.data.set(made2.fd, row.format, body);
        if (b < 0) { account.refusedDrags += 1; return b; }
      }
      const effect = effectFor(row, mods);
      const r = env.data.drag(made2.fd, made.fd, effect);
      if (r < 0) {
        account.refusedDrags += 1;
        return r;
      }
      account.drags += 1;
      account.drops.push({ row: i, name: row.name, offered: granted.map(fmtName) });
      /* M21. WHAT WAS OFFERED, AND WHAT IS STILL OWED. `effectsOffered` is this program's ASK and
       * `effects` is the kernel's answer, which are two different facts: the mask decides the
       * first and only the kernel decides the second. `dragged` is what the receipt acts on — a
       * MOVE completes by removing this path, so the path has to outlive the gesture's samples. */
      account.effectsOffered.push({ row: i, name: row.name, effect });
      dragged = { name: row.name, path: row.path };
      // THE TITLE IS THE ONLY TEXT THIS WINDOW HAS, so it is what says which file is moving.
      env.win.setTitle(made.fd, `${NAME} — dragging ${row.name}`);
      return 0;
    } finally {
      env.fs.close(made2.fd);
    }
  };

  /* `--no-drain MS`: THE FIXTURE, AND IT MUST BE BEFORE THE FIRST POLL. The window exists and has
   * been painted, so a driver has something to aim a wheel at; nothing has been READ, so a stream
   * longer than `WIN_EVENT_CAP` laps the window's queue and `push` starts discarding its NEWEST
   * record. That is the state the kernel's coalescing is proven in and the state an uncoalesced
   * stream loses the reader's latest notch in — a draining program reaches neither, which is why an
   * earlier draft of the proof could assert nothing a control could move.
   *
   * IT PARKS RATHER THAN SPINS. `clock_nanosleep` parks the worker in `Atomics.wait` with a finite
   * re-arm (constraint 46), so the hold costs no CPU and the process stays killable; a
   * `performance.now()` spin would hold a core for the whole stream. -EINTR IS A SHORT SLEEP, so
   * the remainder is re-slept against a DEADLINE: a fixture that silently held for less than it was
   * asked is a check that ran against a program which was draining after all. */
  if (noDrainMs > 0) {
    env.std.say(env, `${NAME}: --no-drain, holding the event loop for ${noDrainMs} ms\n`);
    const heldFrom = performance.now();
    const until = heldFrom + noDrainMs;
    for (let left = noDrainMs; left > 0; left = until - performance.now()) {
      const slept = env.proc.nanosleep(Math.round(left * 1e6));
      // Only -EINTR is worth another pass. Any other refusal is permanent and re-sleeping on it
      // would spin the loop this flag exists to keep quiet.
      if (slept < 0 && slept !== -EINTR) break;
    }
    account.heldMs = performance.now() - heldFrom;
  }

  for (;;) {
    if (performance.now() - t0 > CEILING_MS) {
      account.why = `ceiling ${CEILING_MS} ms reached`;
      break;
    }
    /* M23. THE DECODES, BEFORE THE POLL AND NOWHERE ELSE.
     *
     * HERE BECAUSE THIS IS THE ONE PLACE THE PROCESS IS NEITHER PARKED NOR SPINNING. The poll below
     * parks it in `Atomics.wait` and nothing settles there (measured: 406 ms, zero promises); the
     * event handlers below run between two syscalls but are reached from a drained batch, so a
     * decode awaited inside one would suspend `run` with events still in hand. Before the poll, the
     * cache is brought up to what the viewport wants and the window is repainted once for all of
     * them — which is also why `paint` may never decode: a repaint that evicted an object whose fd
     * it had already put in the batch would have the whole `win_draw` refused with -EBADF. */
    if (await fillThumbs()) paint();
    /* M23. ONE CHUNK OF A SEARCH WALK PER TURN, which is R31's "chunked so the window keeps
     * servicing input" as code: the chunk runs, the loop polls, a keystroke is read. A walk that ran
     * to completion in one turn would make a 20,000-entry tree an unresponsive window whose only
     * symptom is a reader's key arriving seconds late.
     *
     * AND THE POLL IS NOT WAITED OUT WHILE ONE IS IN FLIGHT. `POLL_MS` is 200 ms, so polling between
     * chunks would stretch a 79-chunk walk to sixteen seconds; `continue` takes the next chunk at
     * once and the window still drains its queue, because a chunk is about 1.3 ms. */
    if (walk) {
      if (stepWalk()) paint();
    }
    /* AND THE POLL DOES NOT WAIT WHILE A WALK IS IN FLIGHT. `timeout 0` is a POLL and not a wait
     * (`src/kernel/calls.mjs`), so the queue is drained between every chunk and a reader's Esc
     * arrives within one chunk — about 1.3 ms. Waiting `POLL_MS` between chunks would stretch the
     * 79 chunks of a full ceiling to sixteen seconds of a window that looks stuck; skipping the
     * poll entirely would let a long walk lap a 256-record queue and drop the reader's newest
     * event, which is the defect `WIN_EVENT_CAP`'s own docstring names. */
    const waitMs = walk ? 0 : POLL_MS;
    const r = unInterrupted(() => env.tty.poll([{ fd: made.fd, events: POLLIN }], waitMs));
    if (typeof r === "number") {
      if (r === -EINTR) continue;
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
    let repaint = false;
    /* ONE RE-SURFACE PER DRAINED BATCH, NOT PER EVENT. `win_surface` destroys and rebuilds the
     * canvas page-side, so re-surfacing at every intermediate size of a two-second drag is a
     * rebuild per animation frame, all but one of them thrown away. The kernel replaces a TAIL
     * client record, so a batch carries more than one only when something else arrived between two
     * reports — `std.lastClientEvent` is the one place that collapse is written. */
    const client = env.std.lastClientEvent(evs);
    for (const ev of evs) {
      if (ev.type === WEV_FOCUS) continue;
      // CELLS, and this window has no cell grid: `WEV_RESIZE` is the terminal's event and reading
      // its `a`/`b` as pixels would lay a list view out in columns (PRD §6, A2).
      if (ev.type === WEV_RESIZE) continue;
      if (ev.type === WEV_CLIENT) {
        // COUNTED BEFORE THE COLLAPSE, so `clients` against `resurfaces` is the evidence that one
        // batch cost one canvas rebuild. A counter after it would report only the actions.
        account.clients += 1;
        if (ev !== client) continue;
        // `--no-resurface`: the pre-M16 program, which never asked again. Counted, so a control
        // that sets it is visible in the account rather than only in the pixels.
        if (frozenSurface) continue;
        if (cssPxSurface) { askInCssPx(ev); repaint = true; continue; }
        const got = env.std.resurface(env, made.fd, ev);
        if (!got.ok) {
          /* A REFUSAL IS REPORTED AND SURVIVED, NOT FATAL. `-ENOMEM` is the surface budget and
           * `-EINVAL` is a box past `SURFACE_MAX_PX` — 4096x4096 device px, which a maximized
           * window on a large display at dpr 2 can exceed — and both are permanent, so a retry
           * would retry for ever. The kernel leaves the previous surface in place, so the layout
           * already in hand is still the right one for it: a reader keeps a correct list, CSS
           * stretched, instead of losing the program for making its window bigger.
           *
           * SAID ONCE. The refusal recurs per geometry report, so a message per event would be a
           * line of stdout per animation frame; the count carries the rest. */
          account.refusedSurfaces += 1;
          account.surfaceWhy = `win_surface: ${env.std.errnoName(got.errno)} for `
            + `${got.w}x${got.h} device px`;
          if (account.refusedSurfaces === 1) env.std.say(env, `${NAME}: ${account.surfaceWhy}\n`);
          continue;
        }
        account.resurfaces += 1;
        surfW = got.w;
        surfH = got.h;
        account.surface = { w: got.w, h: got.h };
        relayout(got.wCss, got.hCss, got.dpr);
        // THE OLD CANVAS IS GONE, so a repaint is owed rather than optional: the page built a new
        // backing store and nothing has drawn into it.
        repaint = true;
        continue;
      }
      if (ev.type === WEV_WHEEL) {
        account.wheels += 1;
        const w = wheelAt(ev);
        /* A COALESCED RECORD IS A SUM, NOT A NOTCH. The kernel merges a run of identical-mods
         * notches into its tail record and says so with `WWHEEL_COALESCED`; a program that scrolled
         * by one notch's worth per record would lose the rest of the reader's gesture, which is the
         * whole of what the flag is for. So the delta is applied AS GIVEN and the flag is only
         * counted — there is nothing else to do with it, and that is the honest reading. */
        if (ev.mods & WWHEEL_COALESCED) account.coalescedWheels += 1;
        /* M23. CTRL+WHEEL IS THE VIEW SLIDER (PRD A1), AND IT IS TESTED BEFORE THE SCROLL.
         *
         * IT IS THE ONLY GESTURE ROUTE TO A VIEW MODE, and that is an ABI fact rather than a choice:
         * `bytesForKey` (`src/wm/terminal.mjs`) answers null for every Ctrl chord that is not a C0
         * letter, so Windows' own Ctrl+Shift+1..7 cannot reach a program at all — the key event is
         * dropped before `WEV_KEY` is built. The other two routes are the view button in the address
         * strip and `--view` on argv; neither is a wheel.
         *
         * ONE STEP PER RECORD WHATEVER THE DELTA, which is the opposite of the scroll's rule below
         * and right for the same reason: a scroll is a DISTANCE and a mode is a POSITION in a table
         * of seven, so a coalesced run of four notches that scrolled four notches' worth must step
         * the slider once — otherwise one flick of a trackpad crosses the whole table.
         *
         * THE SIGN IS THE SCROLL'S SIGN: a wheel towards the reader is a positive `dy` and makes
         * the icons smaller, which is the direction every zoom in every program uses. */
        if (ev.mods & WMOD_CTRL) {
          /* A CTRL+WHEEL WITH NO VERTICAL DELTA STEPS NOTHING, and `w.dy > 0 ? 1 : -1` made it
           * step towards LARGER icons — a horizontal flick on a trackpad under Ctrl changed the
           * view mode, which is not a gesture anybody made. It does not fall through to the scroll
           * either: the modifier says the reader asked for the slider, and a Ctrl+wheel that
           * scrolled sideways instead would be one gesture with two meanings. Counted as a wheel
           * above, so a reader looking at the account can see it arrived. */
          if (w.dy !== 0 && stepView(w.dy > 0 ? 1 : -1)) repaint = true;
          continue;
        }
        /* SURFACE PIXELS INTO CSS PIXELS, the division `cssPointAt` does for a pointer. A delta read
         * unconverted scrolls twice as far as the reader's hand at dpr 2 — the same unit error as
         * the display side, on the way in (constraint 248). */
        const box = FILES_METRICS.viewBox(clientW, clientH);
        /* `WWHEEL_PAGE` MEANS THE DELTA IS IN PAGES AND IS NOT SCALED, because a page is not a
         * length the host measured — a reader's `deltaMode` said "a viewport", and the viewport is
         * this program's to define. It is the CLIPPED height and not the client box: a page that
         * jumped by the window's height would step over the rows under the header. */
        if (ev.mods & WWHEEL_PAGE) {
          account.pageWheels += 1;
          if (scrollBy(w.dy * box.h)) repaint = true;
          continue;
        }
        /* `dx` IS READ AND IGNORED, deliberately and not by omission: the name column follows the
         * window and the type column is right-aligned to it, so the list has no horizontal overflow
         * for a horizontal wheel to reach. A program with a tree pane would use `w.x`/`w.y` to pick
         * which pane the gesture was aimed at; this one has a single viewport, so the aim adds
         * nothing and a wheel over the header scrolls the list — which is what Windows does. */
        if (scrollBy(w.dy / S)) repaint = true;
        continue;
      }
      if (ev.type === WEV_POINTER) {
        account.pointers += 1;
        // SURFACE PIXELS INTO CSS PIXELS, through the shared helper. `pointerAt` alone would leave
        // a press two rows off at dpr 2 — the same unit error as the display side, on the way in.
        const at = env.std.cssPointAt(ev, S);
        if (ev.mods & WPTR_DOWN) {
          const i = rowUnder(at.y, at.x);
          /* M20. A PRESS OF ANY BUTTON CLOSES AN OPEN RENAME, AND IS SPENT DOING IT.
           *
           * CANCELLED AND NOT COMMITTED, which is a decision and not a shortcut: a commit renames a
           * file, and a press somewhere else in the list is not a reader saying "rename it to
           * this" — Enter is. The press does nothing else either, because a gesture that both
           * abandoned an edit and selected a different row would make one click two actions. */
          if (editing) {
            if (cancelRename()) repaint = true;
            // AND IT ARMS NOTHING. A press that is spent closing an edit must not leave a drag
            // threshold or a band behind it for the next move to pick up.
            press = null;
            band = null;
            dragging = false;
            continue;
          }
          /**
           * M23. AND A PRESS OUTSIDE THE ADDRESS STRIP CLOSES AN OPEN FIELD, AND IS SPENT DOING IT
           * — M20's rule above, applied to the other two text fields, and it was MISSING.
           *
           * `closeStrip` was reachable only from Esc, so a reader who opened the search box and
           * then clicked a row was left with a field that still owned the whole keyboard: every
           * keysym after that — Delete, F2, F5, every arrow — was swallowed by the handler that
           * takes the keyboard for an open field, silently. A press in the strip itself is NOT
           * this case: that is the reader moving between the two fields, and `openPath`/`openSearch`
           * swap them.
           *
           * SPENT, for `cancelRename`'s own reason: a gesture that both abandoned a half-typed
           * address and selected a different row would make one click two actions.
           */
          if (strip !== "trail" && !(at.y >= CRUMB_TOP && at.y < VIEW_TOP)) {
            if (closeStrip()) repaint = true;
            press = null;
            band = null;
            dragging = false;
            continue;
          }
          /* M20. A RIGHT PRESS RAISES A MENU AND DOES NOTHING ELSE — no selection replaced by it, no
           * drag armed, no band. `c` carries `event.buttons` and bit 1 is the secondary button
           * (`pointerAt`'s `buttons`); there is no `WPTR_*` bit for a button, because a second
           * spelling of a mask the record already holds is two fields to disagree.
           *
           * A ROW THAT IS NOT SELECTED IS SELECTED FIRST AND ONE THAT IS KEEPS THE WHOLE SELECTION,
           * which is Windows' rule and is what makes "Delete 3 items" mean the three rows a reader
           * can see highlighted. */
          if (at.buttons & BTN_RIGHT) {
            // IT ARMS NOTHING, which is the half of "and does nothing else" that is state rather
            // than behaviour: a drag threshold or a band left over from an earlier press would be
            // picked up by the next move and publish a file the reader never dragged.
            press = null;
            band = null;
            dragging = false;
            if (!inViewport(at.y)) {
              refuse("the header", "has no context menu");
              continue;
            }
            if (i >= 0) {
              if (!sel.has(i)) { selectOnly(i); repaint = true; }
              if (i !== focus) { setFocus(i); repaint = true; }
              if (raiseMenu(rowMenuFor(i), at, i)) repaint = true;
              continue;
            }
            if (sel.size > 0 || anchor >= 0) { selectOnly(-1); repaint = true; }
            if (raiseMenu(emptyMenuRows(), at, -1)) repaint = true;
            continue;
          }
          /* THE ARBITRATION, TAKEN HERE AND NOWHERE ELSE. A press that found a row arms the DRAG
           * threshold; a press inside the viewport that found none arms a BAND. Nothing downstream
           * re-decides it, because a gesture that could become either depending on how far the hand
           * moved is a gesture that publishes a file the reader never touched.
           *
           * `--band-from-row` IS THE WORLD WITHOUT IT: every press arms a band, so a press on a row
           * and a drag across its neighbours selects them and no drag session ever begins. */
          const inView = inViewport(at.y);
          press = i >= 0 && !bandFromRow ? { row: i, x: at.x, y: at.y } : null;
          /* M23. THE BAND'S CORNERS ARE CONTENT COORDINATES ON THE MODE'S SCROLL AXIS and window
           * coordinates on the other, which is `bandCorner`'s one definition — in Details that is
           * `y + scroll` exactly as before, and in the List it is the `x` that carries the offset.
           * A band that added the offset to the wrong axis would keep hold of a column it was never
           * drawn over. */
          band = (i < 0 || bandFromRow) && inView
            ? { ...bandCorner(at), ...bandCorner(at, true) }
            : null;
          dragging = false;
          if (setLit(-1)) repaint = true;
          /* A PRESS IN THE HEADER SORTS THE COLUMN UNDER IT. The hit test is `columnAt`, the
           * declared inverse of the geometry the labels were drawn with, so the column a reader
           * pointed at is the column that sorts. A press ABOVE the viewport that is not on a column
           * clears the selection and does no more, which is what it did before M19. */
          /* M23. A PRESS IN THE ADDRESS STRIP IS TESTED FIRST, AND IT IS A DIFFERENT BAND FROM THE
           * COLUMN HEADER. `crumbHit` is `crumbSegments`'s declared inverse, so a press lands on the
           * segment, the field or the button a reader can see. The four answers are exhaustive:
           * `"empty"` is the strip's own background, and R28 says a click there turns the trail into
           * an editable path. */
          if (at.y >= CRUMB_TOP && at.y < VIEW_TOP) {
            const hit = crumbHit(at.x, dir, clientW);
            if (hit.kind === "view") { if (cycleView()) repaint = true; continue; }
            if (hit.kind === "search") { if (openSearch()) repaint = true; continue; }
            if (hit.kind === "segment") {
              const seg = crumbSegments(dir, clientW)[hit.index];
              if (goToCrumb(seg)) repaint = true;
              continue;
            }
            if (openPath()) repaint = true;
            continue;
          }
          if (at.y < CRUMB_TOP) {
            const key = columnAt(at.x, clientW);
            /* M23: AND A PRESS IN A MODE WITH NO COLUMNS SORTS BY THE NEXT KEY. The band holds a
             * sort strip there rather than four labels (`paint`), so there is no column under the
             * pointer to name — and a header a reader can press that does nothing is the defect the
             * disabled caption buttons exist to avoid. Cycling is the only honest reading of a
             * single target that stands for four. */
            if (view.flow !== FLOW_ROWS) {
              const at2 = COLUMNS.findIndex((c) => c.key === sort.key);
              if (sortBy(COLUMNS[(at2 + 1) % COLUMNS.length].key)) repaint = true;
              continue;
            }
            if (key !== null) { if (sortBy(key)) repaint = true; continue; }
            if (sel.size > 0) { selectOnly(-1); repaint = true; }
            continue;
          }
          if (i >= 0) {
            account.presses += 1;
            /* THE THREE SELECTION GESTURES, AND THE MODIFIER DECIDES WHICH.
             *
             * Shift RANGES from the anchor to this row in LAYOUT order, which is index order
             * because the sort reorders `rows` itself. With no anchor there is no range, so a first
             * Shift+press behaves as a plain one rather than selecting from row 0 — a range a
             * reader never started one end of.
             *
             * Ctrl TOGGLES one row AND MOVES THE ANCHOR HERE. The second half is the rule that is
             * easy to miss and is asserted on its own: three Ctrl+presses then a Shift+press must
             * range from the third, or the reader's last gesture is not where the next starts.
             *
             * Neither modifier REPLACES the selection, which is the whole of what they are for. */
            if (ev.mods & WMOD_SHIFT) {
              if (anchor < 0) selectOnly(i);
              else {
                const lo = Math.min(anchor, i);
                const hi = Math.max(anchor, i);
                sel = new Set();
                for (let r = lo; r <= hi; r += 1) sel.add(r);
                reportSelection();
              }
            } else if (ev.mods & WMOD_CTRL) {
              if (sel.has(i)) sel.delete(i);
              else sel.add(i);
              anchor = i;
              reportSelection();
            } else {
              selectOnly(i);
            }
            account.selects += 1;
            repaint = true;
            // THE POINTER CARRIES THE CURSOR WITH IT. Without this, Enter after a click opens a
            // row other than the one the reader just highlighted.
            if (i !== focus) setFocus(i);
          } else if (sel.size > 0 || anchor >= 0) {
            // A PRESS ON EMPTY SPACE CLEARS THE SELECTION, which is where the band starts from.
            selectOnly(-1);
            repaint = true;
          }
          /* THE SECOND CLICK IS THE ACTIVATION VERB, AND THE FIRST ONE IS NOT. `WPTR_CLICK2` rides
           * the DOWN record and nothing else (`src/wm/winhost.mjs`), so this is the only place it
           * can be read — and a single click reaching here has already done the whole of what it
           * may do, which is select. A double-click on blank paper is not a refusal: there is no
           * row under it to refuse, which is a different thing from a row this program will not
           * open. */
          if (ev.mods & WPTR_CLICK2) {
            account.dblclicks += 1;
            if (i >= 0 && activate(i)) repaint = true;
          }
          continue;
        }
        /* THE POINTER LEFT THE SURFACE. It carries no usable position — the event fired outside the
         * window — so the lit row is CLEARED rather than hit-tested, which is `WPTR_LEAVE`'s own
         * contract (src/abi.mjs). Without it the last hover a window ever gets is the one nearest
         * the edge, and that row stays lit for as long as the window is open.
         *
         * TESTED BEFORE THE MOVE, because a leave is not a move: the bits are exclusive and reading
         * it as one would hit-test a coordinate the ABI says is meaningless. */
        if (ev.mods & WPTR_LEAVE) {
          account.leaves += 1;
          if (setLit(-1)) repaint = true;
          continue;
        }
        if (ev.mods & WPTR_UP) {
          /* THE BAND ENDS WITH THE PRESS THAT STARTED IT, and the selection it made STAYS. A band
           * released is a choice taken; only the rectangle goes. */
          if (band) {
            account.bands += 1;
            account.bandSelected = sel.size;
            band = null;
            repaint = true;
          }
          press = null;
          dragging = false;
          continue;
        }
        /* A MOVE, AND IT IS ONE OF THREE THINGS: a band being dragged, a press becoming a drag, or
         * A HOVER. `c` carries `event.buttons`, so a hover is a record with neither button bit and
         * nothing held — which is what makes a drag's own motion samples NOT hovers without this
         * program having to track whether a gesture is in flight. */
        if (band) {
          Object.assign(band, bandCorner(at, true));
          const hit = bandItems(view, band, rows.length, clientW, clientH);
          if (hit.size !== sel.size || [...hit].some((r) => !sel.has(r))) {
            sel = hit;
            reportSelection();
          }
          /* A FRAME PER SAMPLE, AND IT IS OWED RATHER THAN WASTEFUL: the rectangle is the feedback,
           * so a band that only repainted when the selection changed would lag the pointer by a
           * whole row and read as the gesture not working. */
          repaint = true;
          continue;
        }
        if (press && !dragging) {
          const far = Math.abs(at.x - press.x) >= DRAG_THRESHOLD_CSS_PX
            || Math.abs(at.y - press.y) >= DRAG_THRESHOLD_CSS_PX;
          if (!far) continue;
          dragging = true;
          /* THE MODIFIERS ARE READ FROM THE MOVE THAT CROSSED THE THRESHOLD and not from the press:
           * a reader who presses, then holds Ctrl, then drags has asked for a copy, and Windows
           * reads the modifier at the same moment. The record carries them already
           * (`modifierBits`), so there is nothing to track. */
          const began = startDrag(press.row, ev.mods);
          if (began < 0 && account.why) break;
          continue;
        }
        if (press || (ev.c | 0) !== 0) continue;
        account.hovers += 1;
        if (setLit(rowUnder(at.y, at.x))) repaint = true;
        continue;
      }
      /* M21. A DRAG ARRIVED OVER THIS WINDOW. THE OFFER COMES WITH THE ENTER, so a target can say
       * whether it could take the drop before the drop and before any bytes exist — which is what
       * a format tag is for, and `src/bin/imgview.mjs` reads it the same way.
       *
       * NOTHING IS DRAWN FOR IT, and that is the absence of a DRAG_OVER rather than an omission: a
       * list view's feedback is the row the pointer is over, and an ENTER carries ONE position
       * (constraint 243). A highlight placed from it would sit under the pointer's first sample for
       * the whole gesture and tell the reader the wrong row. */
      if (ev.type === WEV_DRAG_ENTER) {
        account.dragEnters += 1;
        account.dragOffers.push({ at: "enter", formats: fmtsOf(ev.c).map(fmtName) });
        continue;
      }
      if (ev.type === WEV_DRAG_LEAVE) {
        account.dragLeaves += 1;
        continue;
      }
      /**
       * M21. A DROP, AND IT IS ALWAYS A COPY-IN.
       *
       * `WEV_DROP` CARRIES THE POSITION AND THE OFFER AND NO EFFECT, and there is no negotiation in
       * this ABI (constraint 240) — so a target that `rename`d would be deciding an effect the
       * SOURCE negotiated. The source completes a move when the kernel tells it the effect was one,
       * which is the division the ABI already has and the one place it can be made.
       *
       * WHERE IT LANDS IS TAKEN ONCE, FROM `rowUnder` ALONE: a DIRECTORY row under the pointer
       * takes it, and everything else in the window — a file row, a gap, the header, the status
       * strip — lands in the open directory. That is the same arbitration the press takes for the
       * drag and the band, for the same reason: a gesture re-decided downstream is a gesture that
       * writes a file somewhere the reader was not pointing.
       */
      if (ev.type === WEV_DROP) {
        account.dropsIn += 1;
        // SURFACE PIXELS INTO CSS PIXELS. `WinHost.#dropPointAt` hands a SURFACED window surface
        // px, which is `WEV_POINTER`'s unit and not the client box's (constraint 248).
        const i = rowUnder(ev.b / S, ev.a / S);
        const into = i >= 0 && rows[i].dir ? rows[i].path : dir;
        /* THIS WINDOW'S OWN DRAG, DROPPED BACK IN THE DIRECTORY IT CAME FROM, IS NOT A LANDING —
         * AND IT IS NOT A REFUSAL EITHER. A drag's own window is a legitimate target, so the kernel
         * delivers the drop (`src/kernel/dataobj.mjs`), and a gesture that began on a row here and
         * ended over the list it began in arrives with every path already in `dir`. `landOne` would
         * refuse once PER PATH for a reader who has made no choice at all, and the re-read behind it
         * would cost a listing of a directory nothing changed. Saying so once and doing nothing is
         * the answer; `WEV_DRAG_DONE` reads the same fact for the other half of the same gesture.
         *
         * A DROP ON A DIRECTORY ROW OF THIS SAME WINDOW IS STILL A MOVE-IN, which is why the test is
         * `into === dir` and not "was this our drag". */
        if (dragged && into === dir) {
          lastDrop = { into, landed: 0 };
          account.dropWhere.push({ into, row: i, landed: 0, of: 0, self: true });
          env.std.say(env, `${NAME}: a drop of this window's own drag, back where it came from\n`);
          continue;
        }
        const opened = env.data.open(DOBJ_WHERE_DROP, made.fd);
        if (typeof opened === "number") {
          refuse("a drop", `dataobj_open: ${env.std.errnoName(opened)}`, opened);
          continue;
        }
        let list = [];
        try {
          const offered = fmtsOf(opened.offer);
          account.dragOffers.push({ at: "drop", formats: offered.map(fmtName) });
          if (!offered.includes(DOBJ_PATHS)) {
            refuse("a drop", `offered ${offered.map(fmtName).join(", ")} and no path list`);
            continue;
          }
          const got = env.data.get(opened.fd, DOBJ_PATHS);
          if (typeof got === "number") {
            refuse("a drop", `dataobj_get paths: ${env.std.errnoName(got)}`, got);
            continue;
          }
          list = env.std.text(got).split("\0").filter((p) => p !== "");
        } finally {
          // THE FD IS THE REFERENCE: closing it is what returns the payload's bytes to the budget
          // (constraint 241).
          env.fs.close(opened.fd);
        }
        if (list.length === 0) {
          refuse("a drop", "carried an empty path list");
          continue;
        }
        const landed = [];
        for (const from of list) {
          const name = landOne(from, into, { moving: false, gesture: "a drop" });
          if (name !== "") landed.push(name);
        }
        lastDrop = { into, landed: landed.length };
        account.dropWhere.push({ into, row: i, landed: landed.length, of: list.length });
        for (const name of landed) account.dropped.push({ name, into });
        env.std.say(env, `${NAME}: a drop landed ${landed.length} of ${list.length} in ${into}\n`);
        /* THE RE-READ IS PAID WHATEVER LANDED, which is `reread`'s own argument: a listing patched
         * in place would make a refused landing indistinguishable from one that worked. A drop into
         * a SUBDIRECTORY selects nothing here, because what it changed is not in this listing. */
        if (reread(into === dir ? landed : [])) repaint = true;
        continue;
      }
      if (ev.type === WEV_DRAG_DONE) {
        /* THE SOURCE'S RECEIPT. A COPY source can ignore it; a MOVE source cannot, because effect
         * 0 means the bytes went nowhere and the original must stay. */
        account.effects.push({ effect: ev.a, target: ev.b });
        env.win.setTitle(made.fd, `${NAME} — ${dir}`);
        const moved = dragged;
        dragged = null;
        if ((ev.a | 0) !== DOBJ_EFFECT_MOVE || !moved) continue;
        /* M21. A MOVE IS COMPLETED HERE, BY THE SOURCE, AND INTO THE BIN RATHER THAN BY `unlink`.
         *
         * THE RECEIPT SAYS THE DROP WAS DELIVERED AND NOT THAT IT WAS COLLECTED. The kernel reports
         * an effect for an event that QUEUED (`src/kernel/dataobj.mjs`), and a target may still
         * have refused the landing by name — an occupied destination, a format it cannot read. So
         * an `unlink` here would destroy a file on the strength of a receipt that does not say what
         * this program needs it to say, and the Bin is exactly the answer to that: the bytes leave
         * the reader's directory, as a move must, and are one Restore away if nobody took them.
         *
         * A DROP ON THIS WINDOW'S OWN WINDOW MOVES NOTHING UNLESS IT LANDED SOMEWHERE ELSE. `b` is
         * the target winid, so the one case where the source and the target are the same process is
         * nameable — and it is TWO cases, not one: a gesture that ended over the list it began in
         * landed nothing (the branch in `WEV_DROP` says so), while one that ended on a DIRECTORY ROW
         * of this same list really did bring the file in, which is Explorer's commonest move. So the
         * test is what the drop DID and not where it went, read from `lastDrop`: removing the
         * original on the strength of a landing that did not happen is the defect, and leaving it on
         * the strength of one that did turns a reader's move into a copy. */
        const ownWindow = (ev.b | 0) === made.win;
        const landedElsewhere = !!lastDrop && lastDrop.landed > 0 && lastDrop.into !== dir;
        lastDrop = null;
        if (ownWindow && !landedElsewhere) {
          refuse(moved.name, "was dropped on its own window, so there is nothing to move");
          continue;
        }
        if (binPathOnce(moved.name, moved.path)) {
          account.movedOut.push(moved.name);
          env.std.say(env, `${NAME}: ${moved.name} moved out; the original is in the Bin\n`);
          if (reread([])) repaint = true;
        }
        continue;
      }
      /**
       * M20. A ROW OF THE MENU WAS PICKED, OR THE MENU WAS CLOSED WITH NOTHING PICKED.
       *
       * `itemAt` IS WHAT MAKES A DISMISSAL ARRIVE AS ONE. `a` is read with `getUint32`, so the
       * kernel's `-1` reads back as 4,294,967,295 without it — and the test is `index < 0` rather
       * than `=== -1`, so a second reason to close a menu is another negative value and not a
       * second comparison here (`src/abi.mjs`).
       *
       * THE OPEN MENU IS DROPPED BEFORE THE VERB RUNS, whichever outcome this is. The kernel has
       * already closed its side on either report, so a `menu` left in hand would be a popup this
       * program believed was on screen — and `beginRename`'s "a rename is already open" check is
       * the kind of thing that then refuses for a reason that is not true.
       *
       * `where` IS TESTED AND NOT ASSUMED. This program publishes no `win_items`, so a `WEV_ITEM`
       * without `WITEM_CONTEXT` indexes a list it never sent; acting on it would be acting on an
       * index into the menu's rows that came from somewhere else entirely.
       */
      if (ev.type === WEV_ITEM) {
        const picked = itemAt(ev);
        const open = menu;
        menu = null;
        account.menuRows = [];
        account.menuTarget = -1;
        account.menuInSurfaceAt = null;
        if (!(picked.where & WITEM_CONTEXT)) {
          refuse(`item ${picked.index}`, "did not come from a context menu, and this window "
            + "publishes no other list");
          continue;
        }
        if (picked.index < 0) {
          account.dismissals += 1;
          env.std.say(env, `${NAME}: the menu was dismissed\n`);
          // A REPAINT ONLY WHERE THERE WAS SOMETHING TO ERASE, which is the in-surface control: the
          // page's own popup is the page's to remove.
          if (menuInSurface) repaint = true;
          continue;
        }
        const row = open ? open.rows[picked.index] : null;
        if (!row) {
          refuse(`menu row ${picked.index}`, "is not a row this process published");
          continue;
        }
        account.chosen.push(row.verb);
        if (runVerb(row.verb, open.target)) repaint = true;
        else if (menuInSurface) repaint = true;
        continue;
      }
      if (ev.type === WEV_KEY) {
        /* A KEYSYM AND A KEY'S BYTES ARE DISJOINT AND EXHAUSTIVE (`src/abi.mjs`'s `keysymOf`), so
         * the keysym is tested first and the byte reader below it never sees an arrow. Reading the
         * bytes first would be reading an empty array for every navigation key. */
        const sym = keysymOf(ev);
        /**
         * M23. AN OPEN ADDRESS OR SEARCH FIELD TAKES THE KEYBOARD, AND IT TAKES ALL OF IT — the
         * same contract an open rename has below, for the same reason and tested FIRST because the
         * two cannot be open together (`strip` is one value, not two booleans).
         *
         * EVERY KEYSYM IS SWALLOWED. A Delete key that reached the list while a reader was typing an
         * address would delete the file the cursor happens to be on, and an arrow would move the
         * cursor out from under the field they are looking at.
         */
        if (strip !== "trail") {
          if (sym !== 0) { account.keysyms += 1; continue; }
          const typed = keyBytesOf(ev);
          if (typed.length !== 1) continue;
          const b = typed[0];
          if (b === KEY_ENTER) { if (commitStrip()) repaint = true; continue; }
          if (b === KEY_ESCAPE) {
            /* ESC CLEARS THE QUERY AS WELL AS CLOSING THE FIELD, when the field is the search one.
             * `closeStrip` puts back what the field OPENED holding — which for a reader who opened
             * an empty box and typed is the empty query, so this is one rule and not two. */
            if (closeStrip()) repaint = true;
            continue;
          }
          if (typeStrip(b)) repaint = true;
          continue;
        }
        /* M20. AN OPEN RENAME TAKES THE KEYBOARD FIRST, AND IT TAKES ALL OF IT. Enter commits, Esc
         * abandons, Backspace deletes a character and a printable byte is typed; everything else —
         * every keysym, every other chord — is SWALLOWED rather than passed through. A Delete key
         * that reached the list while a rename box was open would delete the file being renamed,
         * and a Down arrow would move the cursor out from under the field. */
        if (editing) {
          if (sym !== 0) { account.keysyms += 1; continue; }
          const typed = keyBytesOf(ev);
          if (typed.length !== 1) continue;
          const b = typed[0];
          if (b === KEY_ENTER) { if (commitRename()) repaint = true; continue; }
          if (b === KEY_ESCAPE) { if (cancelRename()) repaint = true; continue; }
          if (b === KEY_BACKSPACE) {
            if (editing.draft.length > 0) {
              editing.draft = editing.draft.slice(0, -1);
              account.renaming = { row: editing.row, was: editing.was, draft: editing.draft };
              repaint = true;
            }
            continue;
          }
          if (b >= PRINTABLE_LO && b <= PRINTABLE_HI) {
            /* BOUNDED BY `NAME_MAX` HERE AS WELL AS IN `nameFault`, so a reader cannot type past
             * the limit and then be told the whole name is wrong — the field stops accepting
             * instead. The byte count is what `NAME_MAX` is in, and these bytes are all one each. */
            if (editing.draft.length < NAME_MAX) {
              editing.draft += String.fromCharCode(b);
              account.renaming = { row: editing.row, was: editing.was, draft: editing.draft };
              repaint = true;
            }
            continue;
          }
          continue;
        }
        if (sym !== 0) {
          account.keysyms += 1;
          /* M20's TWO KEYSYMS. F2 opens a rename on the cursor's row and Delete removes the target
           * set — the same two functions a context menu row runs, through `runVerb`, so a key and a
           * menu cannot come to mean different things. */
          if (sym === WKEY_F2) {
            if (runVerb(V_RENAME, focus)) repaint = true;
            continue;
          }
          if (sym === WKEY_DELETE) {
            if (runVerb(V_DELETE, focus)) repaint = true;
            continue;
          }
          /* M21's KEYSYM. F5 re-lists, which is Windows' binding, and it is NOT a verb of `runVerb`:
           * no menu row runs it, so the one thing that function buys — a key and a row that cannot
           * come to mean different things — has nothing to hold here. */
          if (sym === WKEY_F5) {
            if (refresh()) repaint = true;
            continue;
          }
          /* ALT+LEFT IS BACK, AND IT IS TESTED BEFORE THE BARE KEYSYM. The modifier changes the
           * verb and not the key, so a plain Left must not fall into it.
           *
           * M23: AND A PLAIN LEFT NOW MEANS SOMETHING IN EVERY MODE BUT DETAILS. The Details view
           * has one item per line and no horizontal overflow, so a bare Left there still does
           * nothing — which is what it has always done and what `www/m18.html` drives. In a grid a
           * line holds several files, so Left and Right are the across-the-line step and Up and Down
           * are the whole-line one; the List is the transpose of that, because its lanes run down. */
          /* A PAGE IS WHAT THE VIEWPORT HOLDS, read from the live client box and not from
           * `START_ROWS`: a reader who made the window taller gets a longer page, which is the
           * whole of what a page key means. `pageStepFor` calls `rowsThatFit` in the `rows` flow and
           * already floors at one. */
          const page = pageStepFor(view, rows.length, clientW, clientH);
          /* THE TWO STEPS: one item, and one LANE. In Details the lane step is 1, so Up and Down
           * move by a row exactly as they did; `laneStepFor` is the one place that is decided. */
          const lane = laneStepFor(view, clientW, clientH);
          const acrossStep = view.flow === FLOW_COLUMNS ? lane : 1;
          const downStep = view.flow === FLOW_COLUMNS ? 1 : lane;
          if (sym === WKEY_LEFT) {
            if (ev.mods & WMOD_ALT) { if (goBack()) repaint = true; continue; }
            if (view.flow !== FLOW_ROWS && moveFocus(-acrossStep)) repaint = true;
            continue;
          }
          if (sym === WKEY_RIGHT) {
            if (view.flow !== FLOW_ROWS && moveFocus(acrossStep)) repaint = true;
            continue;
          }
          if (sym === WKEY_DOWN && moveFocus(downStep)) repaint = true;
          else if (sym === WKEY_UP && moveFocus(-downStep)) repaint = true;
          else if (sym === WKEY_PAGE_DOWN && moveFocus(page)) repaint = true;
          else if (sym === WKEY_PAGE_UP && moveFocus(-page)) repaint = true;
          else if (sym === WKEY_HOME && focusAt(0)) repaint = true;
          else if (sym === WKEY_END && focusAt(rows.length - 1)) repaint = true;
          continue;
        }
        const bytes = keyBytesOf(ev);
        if (bytes.length === 1) {
          /* ENTER AND BACKSPACE ARE BYTES, NOT KEYSYMS, and that is the ABI's decision rather than
           * this program's: `bytesForKey` already spells them 10 and 127, and a keysym row for
           * either would take them away from every program that reads them as bytes today. */
          if (bytes[0] === KEY_ENTER) {
            if (activate(focus)) repaint = true;
            continue;
          }
          if (bytes[0] === KEY_BACKSPACE) {
            if (goBack()) repaint = true;
            continue;
          }
          /* M20's FOUR CHORDS, AS BYTES. Each one runs the SAME `runVerb` a menu row does, which is
           * the whole reason that function exists: Ctrl+C and a Copy row must publish the same
           * paths, and two call sites is how they come to publish different ones. */
          if (bytes[0] === KEY_CTRL_X) { if (runVerb(V_CUT, focus)) repaint = true; continue; }
          if (bytes[0] === KEY_CTRL_C) { if (runVerb(V_COPY, focus)) repaint = true; continue; }
          if (bytes[0] === KEY_CTRL_V) { if (runVerb(V_PASTE, focus)) repaint = true; continue; }
          if (bytes[0] === KEY_CTRL_N) {
            if (runVerb(V_NEW_FOLDER, focus)) repaint = true;
            continue;
          }
          /* M23's TWO CHORDS, AND BOTH ARE WINDOWS' OWN BINDINGS.
           *
           * CTRL+F AND CTRL+E BOTH OPEN THE SEARCH FIELD, which is what Windows 7 does — two
           * bindings for one box, because Ctrl+E was Explorer's and Ctrl+F is every other program's.
           * They are C0 bytes (6 and 5), so `bytesForKey` delivers them; `keysymOf` answers 0.
           *
           * ALT+D FOCUSES THE ADDRESS BAR (R28's own clause) AND IT IS NOT A C0 BYTE. `bytesForKey`
           * takes the Ctrl branch only when `ctrlKey && !altKey`, so an Alt chord falls through to
           * `key.length === 1` and arrives as the PLAIN LETTER with `WMOD_ALT` in `mods` — which is
           * why the modifier is tested here and the byte is `d` rather than 4. A reader typing a
           * literal `d` into the list is not affected, because this branch requires the modifier. */
          if ((ev.mods & WMOD_ALT) && String.fromCharCode(bytes[0]).toLowerCase() === "d") {
            if (openPath()) repaint = true;
            continue;
          }
          if (bytes[0] === KEY_CTRL_F || bytes[0] === KEY_CTRL_E) {
            if (openSearch()) repaint = true;
            continue;
          }
          if (String.fromCharCode(bytes[0]) === "q") {
            account.why = "q";
            break;
          }
        }
        continue;
      }
      if (ev.type === WEV_CLOSE) { account.why = "the window asked to close"; break; }
      if (ev.type === WEV_DESTROYED) { account.why = "the window was destroyed"; break; }
    }
    if (repaint) paint();
    if (account.why) break;
  }

  /* M23. EVERY PICTURE IS RELEASED BEFORE THE WINDOW GOES, AND NOT INSTEAD OF BY TEARDOWN. A
   * process holds only integers and teardown closes its fds (constraint 14), so the budget is safe
   * either way — what this buys is `released === ready`, which is the one statement that says THIS
   * PROGRAM gave back what it took rather than that the kernel did it for a program that leaked. */
  dropAllThumbs();
  const destroyed = env.win.destroy(made.fd);
  account.destroyed = Array.isArray(destroyed) ? destroyed : [];
  account.ms = performance.now() - t0;
  env.std.say(env, `${NAME}: ${account.why}. ${account.drags} drag(s) from ${account.presses} `
    + `press(es)\n`);
  /* THE GEOMETRY, IN BOTH UNITS AND NAMED, because a reader looking at a window that is the wrong
   * size needs to know which of the two numbers moved. `0x0 device px` here is a host that never
   * reported a client box, which is a different fault from a ratio of 1 on a dpr-2 display. */
  env.std.say(env, `${NAME}: client ${account.client.w}x${account.client.h} CSS px at dpr `
    + `${account.dpr}, surface ${account.surface.w}x${account.surface.h} device px, `
    + `rows ${account.firstRow + 1}-${account.firstRow + account.shownRows} of ${rows.length} `
    + `shown, ${account.resurfaces} resurface(s)`
    + `${account.refusedSurfaces ? `, ${account.refusedSurfaces} refused` : ""}\n`);
  /* THE SCROLL, AND BOTH ITS ENDS. `scroll` against `dyTotal` is where a delta went — equal means
   * every notch landed, short means the clamp ate the difference — and the two clamp counts are
   * reported separately because a run that only ever hit one end proves one edge. */
  env.std.say(env, `${NAME}: scroll ${Math.round(account.scroll)} of `
    + `${Math.round(account.scrollMax)} CSS px from ${account.wheels} wheel event(s) `
    + `(${account.coalescedWheels} coalesced, ${account.pageWheels} by the page), `
    + `${Math.round(account.dyTotal)} CSS px asked for, clamped ${account.clamped.top} at the top `
    + `and ${account.clamped.bottom} at the end\n`);
  /* THE NAVIGATION, AND THE REFUSALS BESIDE IT. A reader looking at a window that did not open
   * what they double-clicked needs the reason on the same line as the count, and the LAST one is
   * printed because that is the one they just hit; `account.refusals` carries the rest. */
  env.std.say(env, `${NAME}: ${dir}, cursor ${account.focus < 0 ? "none" : account.focus + 1}, `
    + `${account.activations} opened from ${account.dblclicks} double-click(s), `
    + `${account.relists} re-list(s), ${account.backs} back, ${account.spawned.length} spawned, `
    + `${account.refused} refused`
    + `${account.refused ? ` (last: ${account.refusalWhy})` : ""}\n`);
  /* M19: THE COLUMNS' OWN LINE. The sort is where the reader left it; `selected` against `anchor`
   * is the pair a range gesture is read from; `stats` against `dirStats` is the evidence the
   * directory `lstat` was paid, which is the call the Date modified column exists on. */
  env.std.say(env, `${NAME}: sorted by ${account.sort.key} `
    + `${account.sort.dir > 0 ? "ascending" : "descending"}`
    + `${account.sort.chosen ? "" : " (the opening order, unchosen)"}`
    + ` from ${account.sorts} header click(s), `
    + `${account.selected.length} row(s) selected around anchor `
    + `${account.anchor < 0 ? "none" : account.anchor + 1}, `
    + `${account.bands} band(s), ${account.hovers} hover(s) and ${account.leaves} leave(s), `
    + `${account.stats} lstat(s) of which ${account.dirStats} on directories\n`);
  /* M20: THE MENUS AND THE VERBS, ON THEIR OWN LINE. `menus` against `refusedMenus` and
   * `dismissals` is the popup's whole arithmetic, and the four name lists beside it are what the
   * filesystem gained and lost — a reader whose Delete did nothing needs the count and the last
   * refusal in the same place, which is `refusalWhy` on the line above. */
  env.std.say(env, `${NAME}: ${account.menus} menu(s) raised`
    + `${account.refusedMenus ? `, ${account.refusedMenus} refused` : ""}`
    + `, ${account.chosen.length} row(s) chosen and ${account.dismissals} dismissed; `
    + `${account.created.length} created, ${account.renames} renamed, `
    + `${account.deleted.length} deleted, ${account.copies} copy and ${account.cuts} cut to the `
    + `clipboard, ${account.pastes} paste(s) landing ${account.pasted.length} file(s)\n`);
  /* M21: THE BIN, THE REFRESH AND BOTH ENDS OF A DRAG, ON THEIR OWN LINE. `binned` against
   * `permanent` is which delete a reader got; `restored` against the refusals on the line above is
   * whether a Restore found its destination free; `refreshKept` is the half of F5 that is a clause.
   * `stranded` is the record this process could not take back, which is a fact about the Bin's
   * contents and not about the gesture that left it. */
  env.std.say(env, `${NAME}: ${account.bin.binned.length} to ${binRoot}, `
    + `${account.bin.permanent} permanently, ${account.bin.restored.length} restored, `
    + `${account.bin.stranded} record(s) stranded by this process and `
    + `${account.bin.strandedRecords} standing in the Bin; ${account.refreshes} F5 keeping `
    + `${account.refreshKept} selected row(s); ${account.dropsIn} drop(s) in from `
    + `${account.dragEnters} enter(s) landing ${account.dropped.length} file(s), `
    + `${account.movedOut.length} moved out\n`);
  /* M23: THE THUMBNAILS, ON THEIR OWN LINE. `ready` against `fellBack` is R26's whole clause — a
   * picture made of a file's own bytes, against a row that was asked for one and kept its type icon
   * with the reason named. `decoded` is how many times the platform's decoder ran, which is what
   * `evicted` is the other half of: a reader scrolling a long directory pays a decode per picture
   * per visit and the cap is why. `bytes` is 0 here by `dropAllThumbs` above, and the figure that
   * matters is `thumbs.bytes` read while the window is open. */
  /* M23: THE VIEW MODE, ON ITS OWN LINE. `view` against `viewSwitches` is whether a reader got
   * where they are by choosing or by opening; `lanes` and the axis are the layout's own statement
   * of its shape, which is what a driver outside the process needs to find the second cell of a
   * grid. */
  env.std.say(env, `${NAME}: ${account.viewLabel} (${account.view}), `
    + `${account.lanes} cell(s) across, scrolling ${account.viewAxis === "x" ? "sideways" : "down"}`
    + `, from ${account.viewSwitches} switch(es), ${account.viewsRemembered} folder(s) `
    + "remembered\n");
  /* M23: THE ADDRESS STRIP AND THE SEARCH, ON THEIR OWN LINE. `crumbNav` is how many navigations
   * came from the trail or the typed path, against `relists` which counts every navigation; `query`
   * with `matched` of `listed` is R31's whole statement, and `searchCost` says plainly what it
   * cost — a filter over the rows in hand reads 0 directories, a walk reads one per directory. */
  env.std.say(env, `${NAME}: ${account.crumbs.length} crumb(s), ${account.crumbNav} navigation(s) `
    + `from the address strip, ${account.pathEdits} path edit(s); `
    + `${account.searches} narrowing(s) and ${account.deepSearches} walk(s), `
    + `query ${account.query === "" ? "none" : `"${account.query}"`} matching `
    + `${account.matched} of ${account.listed}, costing ${account.searchCost.dirsRead} `
    + `directory read(s), ${account.searchCost.entriesSeen} entries and `
    + `${Math.round(account.searchCost.ms)} ms`
    + `${account.searchCost.why ? ` (${account.searchCost.why})` : ""}\n`);
  /* M23: AND WHAT THE LISTING'S OWN `lstat`s COST, which is all A10 could be answered with from
   * inside this program. One call per row is what R7's Date modified and Size columns are paid for;
   * A10's fix is a `readdir` that returns the stat beside the dirent, which is `src/abi.mjs`,
   * `src/kernel/calls.mjs` and `src/kernel/synth.mjs` — three files this slice does not own. The
   * figure is what a reader of that change would be removing. */
  env.std.say(env, `${NAME}: ${account.stats} lstat(s) in `
    + `${account.statMs.toFixed(2)} ms`
    + `${account.stats > 0 ? `, ${(account.statMs * 1000 / account.stats).toFixed(1)} µs each` : ""}`
    + ` (A10's cost, measured)\n`);
  env.std.say(env, `${NAME}: ${account.thumbs.ready} thumbnail(s) of `
    + `${account.thumbs.wanted} wanted, ${account.thumbs.fellBack} on the type icon, `
    + `${account.thumbs.capped} past the ${THUMB_CAP}-object cap; ${account.thumbs.decoded} `
    + `decode(s) in ${Math.round(account.thumbs.decodeMs)} ms, ${account.thumbs.evicted} evicted, `
    + `${account.thumbs.released} released, peak ${account.thumbs.peakBytes} B, `
    + `${account.thumbs.clamped} clamped to ${THUMB_MAX_SIDE} px\n`);
  return { exit: 0, ...account };
}
