// M22: A14's substitute-chord table. ONE DEFINITION, read by the menus that LABEL a chord and by
// the dispatcher that LISTENS for it.
//
// ## Why there is a substitute at all
//
// Alt+Tab is the window manager's, not the page's. `bench/m22-switch/probe.py` dispatched 25
// candidate chords into a served fixture in Chrome over `scripts/cdp.py` and Firefox over
// `scripts/bidi.py` and scored each on five clauses — received, modifiers intact, `code` intact,
// `preventDefault` honoured, and the host quiet — running every chord a second time with the
// listener cancelling nothing, which is the per-chord positive control for that last clause.
// Alt+Tab reads `host: "stopped"` in Chrome: the key arrives, and cancelling it is what keeps the
// host from acting. A chord whose host action only a `preventDefault` suppresses is a chord this
// page is borrowing, so it is in `BLOCKED` below and MUST NOT be offered or labelled.
// Committed evidence: `bench/m22-switch/results-headless.json`, `results-headed.json`.
//
// ## Why this file is in `src/wm/` and not in `src/abi.mjs`
//
// A chord is not a fact the kernel and a process must agree on. Both readers are page-side — the
// shell draws the label, `src/wm/winhost.mjs` dispatches the key — and `KeyboardEvent.code` is a
// browser string, where `src/abi.mjs` holds the integers both sides of the syscall channel share
// and nothing else. The MODIFIER side is an ABI fact and is imported from there, so the bits this
// table compares are the same bits `WinHost.modifierBits` produces.
//
// ## THE BINDING IS ON `code` AND NEVER ON `key`
//
// Measured, not assumed: Firefox delivers Shift+Backquote as `key: "~"` where Chrome over CDP
// delivers `key: "`"`. Both deliver `code: "Backquote"`. A dispatcher matching `event.key === "`"`
// works in Chrome and silently misses Alt+Shift+` in Firefox — with every Chrome expectation
// green, which is the shape of all five Chrome-only bills `CLAUDE.md` records. `codeAt` is the only
// field read.

import { WMOD_SHIFT, WMOD_CTRL, WMOD_ALT, WMOD_META } from "../abi.mjs";

/**
 * WHAT EACH `code` IS CALLED IN A MENU. The one place a physical key becomes a printable name, so
 * a label cannot drift from the binding it advertises: every row's label below is DERIVED through
 * `labelFor` and none is written out.
 *
 * `Backquote` IS SPELLED "`" AND NOT "~". The label names the key a reader presses, and
 * Shift+Backquote is still the Backquote key — which is also the engine disagreement this file
 * exists to survive, since Firefox's `key` for it is "~".
 */
const KEY_LABEL = Object.freeze({
  Backquote: "`",
  Digit1: "1", Digit2: "2", Digit3: "3", Digit4: "4", Digit5: "5",
  Digit6: "6", Digit7: "7", Digit8: "8", Digit9: "9",
});

/**
 * A chord's human-facing spelling.
 *
 * THE MODIFIER ORDER IS Ctrl, Alt, Shift, Meta — Windows' own written order, which is what makes
 * Alt+Shift+` read as "Alt+Shift+`" and not "Shift+Alt+`". A menu is read against the reader's
 * memory of other menus, so the order is a fact about the audience and not a preference.
 */
export function labelFor(code, mods) {
  const parts = [];
  if (mods & WMOD_CTRL) parts.push("Ctrl");
  if (mods & WMOD_ALT) parts.push("Alt");
  if (mods & WMOD_SHIFT) parts.push("Shift");
  if (mods & WMOD_META) parts.push("Meta");
  const name = KEY_LABEL[code];
  if (name === undefined) return "";
  parts.push(name);
  return parts.join("+");
}

/** What a chord DOES, as the two actions a shell has to implement. */
export const CHORD_SWITCH = "switch";
export const CHORD_SELECT = "select";

/** How many Superbar buttons the direct-select set reaches. Nine, because Alt+0 is not in the
 *  measured set and a tenth row would be a chord nothing proved free. */
export const SELECT_SLOTS = 9;

function row(id, code, mods, action, arg) {
  return Object.freeze({ id, code, mods, action, arg, label: labelFor(code, mods) });
}

/**
 * THE TABLE. `id` is the probe's own id for the same chord, so a label in a menu, a binding in the
 * dispatcher and `bench/m22-switch/probe.py --only <id>` all name one row.
 *
 * WHY Alt+` AND Alt+Shift+` over Ctrl+`, which scores identically on all five clauses: Windows 7's
 * switcher is Alt-based, so the modifier is the one a reader already associates with switching; `
 * is the key physically next to Tab, which makes it the nearest gesture to Alt+Tab that the host
 * leaves alone; and macOS's own "next window within this app" is Cmd+`, the exact semantic
 * analogue. It is the only qualifying pair whose REVERSE is also measured free without reaching for
 * Ctrl.
 *
 * `arg` IS THE DIRECTION FOR A SWITCH AND THE SLOT FOR A SELECT, which is what lets the dispatcher
 * stay a lookup: it reads `action` and `arg` and calls one of two shell methods. A dispatcher with
 * a branch per chord is a dispatcher a tenth chord edits.
 */
export const CHORDS = Object.freeze([
  row("alt-backquote", "Backquote", WMOD_ALT, CHORD_SWITCH, 1),
  row("alt-shift-backquote", "Backquote", WMOD_ALT | WMOD_SHIFT, CHORD_SWITCH, -1),
  ...Array.from({ length: SELECT_SLOTS }, (unused, i) => row(
    `alt-${i + 1}`, `Digit${i + 1}`, WMOD_ALT, CHORD_SELECT, i + 1)),
]);

/**
 * THE CHORDS THE MEASUREMENT DISQUALIFIED, kept as data and not as prose.
 *
 * A chord is blocked when it is not free in both engines, or when the host acts on it unless the
 * page cancels — `host: "stopped"`. Being suppressible is not being free: it means the page is
 * holding back a binding that belongs to something else, and the day a browser makes that binding
 * uncancellable the chord stops working with nothing thrown.
 *
 * THIS LIST IS WHY Alt+Tab HAS NO LABEL ANYWHERE. `selfTest` asserts no row above collides with
 * one of these, so adding a blocked chord to the table fails at module load rather than shipping a
 * menu that advertises an accelerator the system is only borrowing.
 */
export const BLOCKED = Object.freeze([
  Object.freeze({ id: "alt-tab", code: "Tab", mods: WMOD_ALT, label: "Alt+Tab",
    why: 'Chrome host="stopped": the host acts unless the page cancels' }),
  Object.freeze({ id: "alt-shift-tab", code: "Tab", mods: WMOD_ALT | WMOD_SHIFT,
    label: "Alt+Shift+Tab", why: 'Chrome host="stopped"' }),
  Object.freeze({ id: "f6", code: "F6", mods: 0, label: "F6",
    why: 'Chrome host="stopped": focus leaves the page' }),
  Object.freeze({ id: "shift-f6", code: "F6", mods: WMOD_SHIFT, label: "Shift+F6",
    why: 'Chrome free=false, host="anyway": the host acts even when cancelled' }),
]);

/**
 * The chord bound to a physical key and an EXACT modifier word, or null.
 *
 * EXACT AND NOT A SUBSET. Alt+Shift+` must not also fire Alt+`, and a chord that fired on any
 * superset would make every modifier a reader happens to be holding a different gesture.
 */
export function chordAt(code, mods) {
  const want = mods >>> 0;
  for (const chord of CHORDS) {
    if (chord.code === code && chord.mods === want) return chord;
  }
  return null;
}

/** The two switch rows and a slot row, for a menu that has to print the accelerator. */
export const SWITCH_NEXT = chordAt("Backquote", WMOD_ALT);
export const SWITCH_PREV = chordAt("Backquote", WMOD_ALT | WMOD_SHIFT);

export function slotChord(n) {
  if (!Number.isInteger(n) || n < 1 || n > SELECT_SLOTS) return null;
  return CHORDS.find((c) => c.action === CHORD_SELECT && c.arg === n) || null;
}

/**
 * THE ONE ROUTE A DISPATCHER TAKES A CHORD BY, and `preventDefault` is called HERE rather than left
 * to the caller.
 *
 * Every chord in the table reads `host: "never"` in both engines, so nothing leaks today — but F6
 * measured `host: "stopped"` in Chrome, which is the demonstration of what a missed
 * `preventDefault` costs on a chord the host binds: the reader's focus leaves the page, no error is
 * thrown anywhere, and the next key goes to the browser. A matched chord is the page's, so the
 * match and the cancel are one call and cannot come apart.
 *
 * `mods` IS THE CALLER'S, because `WinHost.modifierBits` is the one definition of how a
 * `KeyboardEvent` becomes `WMOD_*` bits and a second reading of `altKey` here would be the copy
 * that drifts.
 */
export function takeChord(event, mods) {
  const chord = chordAt(event.code, mods);
  if (!chord) return null;
  event.preventDefault();
  return chord;
}

export function selfTest() {
  const fail = (why) => { throw new Error(`chords.mjs: ${why}`); };

  if (CHORDS.length !== 2 + SELECT_SLOTS) {
    fail(`the table has ${CHORDS.length} rows, expected ${2 + SELECT_SLOTS}`);
  }
  // NO TWO ROWS ON ONE PHYSICAL GESTURE, or `chordAt` returns whichever came first and one of the
  // two chords is dead with nothing said.
  const seen = new Set();
  for (const chord of CHORDS) {
    const bind = `${chord.code}/${chord.mods}`;
    if (seen.has(bind)) fail(`two rows bind ${bind}`);
    seen.add(bind);
    if (!chord.label) fail(`${chord.id} has no label: its code is missing from KEY_LABEL`);
    if (chordAt(chord.code, chord.mods) !== chord) fail(`${chord.id} is not reachable by chordAt`);
  }
  // THE MEASURED-BLOCKED SET IS NOT IN THE TABLE, and no row wears a blocked chord's name. The
  // second half is the one that catches a hand-written label: a row bound to Backquote and labelled
  // "Alt+Tab" passes every other clause here.
  const labels = new Set(CHORDS.map((c) => c.label));
  for (const bad of BLOCKED) {
    if (chordAt(bad.code, bad.mods)) fail(`${bad.id} is bound and it is blocked: ${bad.why}`);
    if (labels.has(bad.label)) fail(`a row is labelled ${bad.label}, which is blocked: ${bad.why}`);
  }
  // THE VERBATIM REQUIREMENT, asserted rather than written into the table twice. The owner's rule
  // is that the menu publishes the REAL accelerator, so these two strings are a contract with a
  // reader and not a formatting choice.
  if (SWITCH_NEXT === null || SWITCH_NEXT.label !== "Alt+`") {
    fail(`the forward chord labels as ${JSON.stringify(SWITCH_NEXT && SWITCH_NEXT.label)}`);
  }
  if (SWITCH_PREV === null || SWITCH_PREV.label !== "Alt+Shift+`") {
    fail(`the reverse chord labels as ${JSON.stringify(SWITCH_PREV && SWITCH_PREV.label)}`);
  }
  if (SWITCH_NEXT.arg !== 1 || SWITCH_PREV.arg !== -1) {
    fail("the switch pair does not run in opposite directions");
  }
  // A SUPERSET MUST NOT MATCH. Alt+Shift+` is its own row, so an Alt+` that fired on it would make
  // the reverse chord unreachable — in Chrome AND in Firefox, since this is arithmetic and not an
  // engine.
  if (chordAt("Backquote", WMOD_ALT | WMOD_CTRL) !== null) fail("Alt+Ctrl+` matched a chord");
  if (chordAt("Backquote", 0) !== null) fail("a bare ` matched a chord");
  // AND THE SLOTS ARE DENSE OVER 1..SELECT_SLOTS, so a shell may index the band by them.
  for (let n = 1; n <= SELECT_SLOTS; n += 1) {
    const chord = slotChord(n);
    if (!chord || chord.arg !== n) fail(`slot ${n} has no chord`);
    if (chord.label !== `Alt+${n}`) fail(`slot ${n} labels as ${chord.label}`);
  }
  if (slotChord(0) !== null || slotChord(SELECT_SLOTS + 1) !== null) {
    fail("slotChord accepted a slot outside the set");
  }
  return { chords: CHORDS.length, blocked: BLOCKED.length, slots: SELECT_SLOTS };
}

/* RUN AT MODULE LOAD, which is `src/abi.mjs`'s convention and `src/wm/icons.mjs`'s own note: a
 * module that cannot keep the contract it is the other half of must not load. The whole of the
 * value here is the `BLOCKED` clause — a chord added to the table that the measurement
 * disqualified, or a row wearing Alt+Tab's name, is a MENU ADVERTISING AN ACCELERATOR the system is
 * only borrowing, and nothing on screen would say so. It is a loop over eleven rows. */
selfTest();
