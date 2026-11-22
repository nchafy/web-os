// M14: THE ICON SET, redrawn. One definition, drawn as vectors, used by the desktop, the Superbar,
// the start menu and every jump list.
//
// WHY IT IS REDRAWN AND NOT SHIPPED. Windows 7's icons are Microsoft's and are not redistributable
// (constraint 37, `docs/research/06-aero-spec.md`), so there is no legal way to ship the originals
// and no honest way to pretend these are them. What is reproduced is the GRAMMAR of the Aero icon
// style, which is observable and is not anybody's property:
//
//   - a 3/4 perspective, lit from the upper left, with the light edge on top
//   - a vertical gloss gradient, strongest in the top third
//   - a 1 px darker outline, so an icon reads against both a bright and a dark backdrop
//   - saturated accents on a desaturated body, which is what makes a Win7 icon read at 16 px
//
// WHY VECTORS AND NOT A SPRITE SHEET. There is no build step in this project (`CLAUDE.md`), a
// raster set would need one per device-pixel ratio, and `src/abi.mjs` gives a program an icon ID
// rather than a file — so the page is the only side that needs to know what one looks like, and a
// string of SVG is the cheapest thing that satisfies that.
//
// THERE IS NO SYSCALL IN THIS FILE and nothing here reads the filesystem. A program chooses an id
// (`iconForPath` in `src/libos/std.mjs`, which is userland's convention); this file turns an id
// into pixels.

import {
  WICON_GENERIC, WICON_FOLDER, WICON_TEXT, WICON_IMAGE, WICON_PROGRAM, WICON_TERMINAL,
  WICON_PAINT, WICON_EDITOR, WICON_FILES, WICON_COMPUTER, WICON_TRASH, WICON_LIMIT,
} from "../abi.mjs";

/* THE PROGRAM TABLE IS BELOW THE IMPORTS AND ABOVE THE DRAWINGS, because it is the one thing in
 * this file that is about PROGRAMS rather than about pixels. */

/**
 * WHICH ICON A PROGRAM GETS, and the basename it is keyed by.
 *
 * IT LIVES HERE AND NOT IN THE TASKBAR because two places need it: a taskbar button and a window's
 * CAPTION, which is Windows 7's own arrangement — the frame shows the program's icon at the left
 * of its caption and the bar shows the same icon. A second copy is how the two come to disagree
 * about what a terminal looks like.
 *
 * A SHELL CONVENTION, page-side, and the honest place for it: a window does not publish an icon
 * for itself — `win_create` has no spare register, and an icon is a property of the PROGRAM rather
 * than of a window — so the shell recognises the programs it ships with and falls back for
 * everything else. Same shape as `FORMAT_BY_EXT` in `src/libos/std.mjs`.
 */
const ICON_BY_PROG = Object.freeze({
  term: WICON_TERMINAL,
  sh: WICON_TERMINAL,
  winopen: WICON_PROGRAM,
  paint: WICON_PAINT,
  editor: WICON_EDITOR,
  files: WICON_FILES,
  imgview: WICON_IMAGE,
  desktop: WICON_COMPUTER,
  clip: WICON_TEXT,
});

/**
 * The name a program is known by: the basename of what the kernel reported, WITHOUT a module
 * extension.
 *
 * THE EXTENSION IS WHY THIS IS A FUNCTION. A program started from `/usr/bin` is `term`, and one
 * the page spawned by URL is `/src/bin/term.mjs` — `src/kernel/providerfs.mjs` drops the extension
 * from a mount name on purpose, so the two spellings of one program reach the shell differently.
 * Measured by LOOKING at the desktop: a jump list titled `term.mjs` with a generic icon, because
 * neither the table above nor a reader recognises that as the terminal.
 */
export function progName(prog) {
  const path = String(prog || "");
  const at = path.lastIndexOf("/");
  const base = (at >= 0 ? path.slice(at + 1) : path) || "program";
  return base.endsWith(".mjs") ? base.slice(0, -4) : base;
}

/** The icon id for a program path, by the name above. `WICON_PROGRAM` for anything unrecognised,
 *  which is what a reader should see for a program this shell was not written for. */
export function iconForProgram(prog) {
  const name = progName(prog);
  return Object.prototype.hasOwnProperty.call(ICON_BY_PROG, name)
    ? ICON_BY_PROG[name]
    : WICON_PROGRAM;
}

/** Gradient ids must be unique per DOCUMENT, not per icon: two icons of the same kind on one
 *  desktop would otherwise both resolve `#page-gloss` to whichever was appended last, and an
 *  icon's fill would change when an unrelated icon was removed. */
let serial = 0;

/** The one place an icon's drawing says how big it is. Every path below is written in this box and
 *  scaled by the `viewBox`, so a 16 px taskbar icon and a 48 px desktop icon are one drawing. */
const BOX = 48;

/** A readable name per id, for `aria-label` and for a check's failure message. */
export const ICON_NAME = Object.freeze({
  [WICON_GENERIC]: "File",
  [WICON_FOLDER]: "Folder",
  [WICON_TEXT]: "Text document",
  [WICON_IMAGE]: "Image",
  [WICON_PROGRAM]: "Program",
  [WICON_TERMINAL]: "Terminal",
  [WICON_PAINT]: "Paint",
  [WICON_EDITOR]: "Editor",
  [WICON_FILES]: "Explorer",
  [WICON_COMPUTER]: "Computer",
  [WICON_TRASH]: "Recycle Bin",
});

/**
 * The drawings. Each is a function of a unique suffix so its gradient ids are its own, and each
 * returns the INNER markup of a 48x48 `viewBox` — the wrapper is `iconMarkup`'s, so no drawing
 * repeats the box or the namespace.
 *
 * The shared vocabulary, so a reader can tell what is a drawing decision from what is the style:
 *   `sheet`   a page: white, a folded top-right corner, a grey outline
 *   `gloss`   the vertical highlight every Aero surface carries
 */
const DRAWINGS = {
  [WICON_GENERIC]: (u) => `
    <defs>
      <linearGradient id="g-page-${u}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#ffffff"/><stop offset=".55" stop-color="#f3f7fb"/>
        <stop offset="1" stop-color="#dfe8f2"/>
      </linearGradient>
    </defs>
    <path d="M11 4h18l8 8v32H11z" fill="url(#g-page-${u})" stroke="#8ea4bd" stroke-width="1.2"/>
    <path d="M29 4v8h8" fill="#cfdcea" stroke="#8ea4bd" stroke-width="1.2"/>`,

  [WICON_TEXT]: (u) => `
    <defs>
      <linearGradient id="g-page-${u}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#ffffff"/><stop offset=".55" stop-color="#f3f7fb"/>
        <stop offset="1" stop-color="#dfe8f2"/>
      </linearGradient>
    </defs>
    <path d="M11 4h18l8 8v32H11z" fill="url(#g-page-${u})" stroke="#8ea4bd" stroke-width="1.2"/>
    <path d="M29 4v8h8" fill="#cfdcea" stroke="#8ea4bd" stroke-width="1.2"/>
    <g stroke="#7d8fa6" stroke-width="1.6" stroke-linecap="round">
      <path d="M16 20h16M16 25h16M16 30h16M16 35h10"/>
    </g>`,

  [WICON_IMAGE]: (u) => `
    <defs>
      <linearGradient id="g-sky-${u}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#9fd8ff"/><stop offset="1" stop-color="#e8f6ff"/>
      </linearGradient>
    </defs>
    <path d="M11 4h18l8 8v32H11z" fill="#fbfdff" stroke="#8ea4bd" stroke-width="1.2"/>
    <path d="M29 4v8h8" fill="#cfdcea" stroke="#8ea4bd" stroke-width="1.2"/>
    <rect x="15" y="18" width="18" height="14" fill="url(#g-sky-${u})" stroke="#8ea4bd"/>
    <circle cx="20" cy="23" r="2.6" fill="#ffd45e"/>
    <path d="M15 32l6-7 5 5 3-3 4 5z" fill="#6fae57"/>`,

  [WICON_FOLDER]: (u) => `
    <defs>
      <linearGradient id="g-back-${u}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#ffd98a"/><stop offset="1" stop-color="#e8aa3c"/>
      </linearGradient>
      <linearGradient id="g-front-${u}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#ffe9b4"/><stop offset=".48" stop-color="#ffc85c"/>
        <stop offset=".52" stop-color="#f7b63f"/><stop offset="1" stop-color="#d89323"/>
      </linearGradient>
    </defs>
    <path d="M5 12h14l4 4h20v6H5z" fill="url(#g-back-${u})" stroke="#b7811f" stroke-width="1.1"/>
    <path d="M5 18h38l-4 20H9z" fill="url(#g-front-${u})" stroke="#b7811f" stroke-width="1.1"/>
    <path d="M7 20h34l-1.2 6H8z" fill="#ffffff" opacity=".28"/>`,

  [WICON_PROGRAM]: (u) => `
    <defs>
      <linearGradient id="g-cap-${u}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#bfe6ff"/><stop offset="1" stop-color="#5fa8dd"/>
      </linearGradient>
    </defs>
    <rect x="6" y="9" width="36" height="30" rx="3" fill="#f4f8fc" stroke="#5b7d9c"
      stroke-width="1.3"/>
    <path d="M7 10h34v8H7z" fill="url(#g-cap-${u})"/>
    <g fill="#ffffff" opacity=".9">
      <circle cx="35" cy="14" r="1.6"/><circle cx="30" cy="14" r="1.6"/>
    </g>
    <g stroke="#9bb0c6" stroke-width="1.6" stroke-linecap="round">
      <path d="M12 25h24M12 30h18"/>
    </g>`,

  [WICON_TERMINAL]: (u) => `
    <defs>
      <linearGradient id="g-screen-${u}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#2b3a4a"/><stop offset="1" stop-color="#0d1620"/>
      </linearGradient>
    </defs>
    <rect x="6" y="9" width="36" height="30" rx="3" fill="url(#g-screen-${u})" stroke="#4a6378"
      stroke-width="1.3"/>
    <path d="M7 10h34v7H7z" fill="#ffffff" opacity=".10"/>
    <g fill="#9ff0a8" font-family="monospace" font-size="11">
      <text x="12" y="27">&gt;_</text>
    </g>`,

  [WICON_PAINT]: (u) => `
    <defs>
      <linearGradient id="g-pal-${u}" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#fff3d6"/><stop offset="1" stop-color="#e0bb86"/>
      </linearGradient>
    </defs>
    <path d="M24 8c9 0 16 6 16 13 0 5-4 6-7 6h-3c-2 0-3 1-3 3 0 3-2 6-6 6-8 0-13-7-13-14S15 8 24 8z"
      fill="url(#g-pal-${u})" stroke="#9c7a4a" stroke-width="1.2"/>
    <circle cx="18" cy="17" r="2.6" fill="#e4453c"/>
    <circle cx="27" cy="15" r="2.6" fill="#2f7fd0"/>
    <circle cx="33" cy="22" r="2.6" fill="#f2c53d"/>
    <circle cx="17" cy="27" r="2.6" fill="#59a94b"/>`,

  [WICON_EDITOR]: (u) => `
    <defs>
      <linearGradient id="g-pad-${u}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#e4ecf5"/>
      </linearGradient>
    </defs>
    <rect x="10" y="5" width="28" height="38" rx="2" fill="url(#g-pad-${u})" stroke="#8ea4bd"
      stroke-width="1.2"/>
    <path d="M11 6h26v6H11z" fill="#5fa8dd"/>
    <g stroke="#8ba0b8" stroke-width="1.5" stroke-linecap="round">
      <path d="M15 19h18M15 24h18M15 29h12"/>
    </g>
    <path d="M28 36l10-10 4 4-10 10h-4z" fill="#ffd45e" stroke="#b58c22" stroke-width="1"/>`,

  [WICON_FILES]: (u) => `
    <defs>
      <linearGradient id="g-front-${u}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#ffe9b4"/><stop offset=".5" stop-color="#ffc85c"/>
        <stop offset="1" stop-color="#d89323"/>
      </linearGradient>
    </defs>
    <path d="M5 12h14l4 4h20v6H5z" fill="#e8aa3c" stroke="#b7811f" stroke-width="1.1"/>
    <rect x="16" y="14" width="16" height="18" fill="#ffffff" stroke="#8ea4bd"/>
    <g stroke="#7d8fa6" stroke-width="1.4" stroke-linecap="round">
      <path d="M19 19h10M19 23h10M19 27h7"/>
    </g>
    <path d="M5 20h38l-4 18H9z" fill="url(#g-front-${u})" stroke="#b7811f" stroke-width="1.1"/>`,

  [WICON_COMPUTER]: (u) => `
    <defs>
      <linearGradient id="g-glass-${u}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#8fd0f5"/><stop offset=".5" stop-color="#3f86c4"/>
        <stop offset="1" stop-color="#1d4f7d"/>
      </linearGradient>
      <linearGradient id="g-case-${u}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#f2f6fa"/><stop offset="1" stop-color="#b9c7d6"/>
      </linearGradient>
    </defs>
    <rect x="5" y="9" width="38" height="26" rx="2.5" fill="url(#g-case-${u})" stroke="#6b8299"
      stroke-width="1.3"/>
    <rect x="8" y="12" width="32" height="18" fill="url(#g-glass-${u})"/>
    <path d="M8 12h32v7H8z" fill="#ffffff" opacity=".22"/>
    <path d="M18 35h12l2 6H16z" fill="url(#g-case-${u})" stroke="#6b8299" stroke-width="1.2"/>
    <rect x="12" y="41" width="24" height="3" rx="1.5" fill="#9fb2c4" stroke="#6b8299"/>`,

  [WICON_TRASH]: (u) => `
    <defs>
      <linearGradient id="g-bin-${u}" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0" stop-color="#dff0fb" stop-opacity=".95"/>
        <stop offset=".45" stop-color="#9dc6e4" stop-opacity=".75"/>
        <stop offset="1" stop-color="#cfe6f6" stop-opacity=".95"/>
      </linearGradient>
    </defs>
    <path d="M13 16h22l-2.5 25a3 3 0 0 1-3 2.6H18.5a3 3 0 0 1-3-2.6z" fill="url(#g-bin-${u})"
      stroke="#6e93ad" stroke-width="1.2"/>
    <g stroke="#6e93ad" stroke-width="1.1" opacity=".8">
      <path d="M20 21v18M24 21v18M28 21v18"/>
    </g>
    <rect x="10" y="10" width="28" height="5" rx="2.5" fill="#cfe6f6" stroke="#6e93ad"
      stroke-width="1.2"/>
    <path d="M20 10V8h8v2" fill="none" stroke="#6e93ad" stroke-width="1.4"/>`,
};

/** The id to draw for anything unknown. A row whose icon this file does not have must still be
 *  drawn — a shell that rendered nothing would show a desktop with a gap in it. */
const FALLBACK = WICON_GENERIC;

/**
 * One icon, as SVG markup, in a box `size` px square.
 *
 * MARKUP AND NOT AN ELEMENT, because every caller is building a row of them and setting
 * `innerHTML` once on the row is one parse instead of N appends. Nothing here comes from a
 * program: the LABEL beside an icon is program text and is set as `textContent` by the caller —
 * this is a drawing chosen by an integer.
 */
export function iconMarkup(id, size = 32) {
  serial += 1;
  const draw = DRAWINGS[id | 0] || DRAWINGS[FALLBACK];
  const name = ICON_NAME[id | 0] || ICON_NAME[FALLBACK];
  return `<svg class="wicon" width="${size}" height="${size}" viewBox="0 0 ${BOX} ${BOX}" `
    + `role="img" aria-label="${name}" focusable="false">${draw(serial)}</svg>`;
}

/** Whether this file can draw `id` at all, so a check can assert the table is covered rather than
 *  discovering a fallback by looking at it. */
export function hasIcon(id) {
  return Object.prototype.hasOwnProperty.call(DRAWINGS, id | 0);
}

/** Every id this file draws. Asserted against the ABI's own table by `selfTest`. */
export function drawnIcons() {
  return Object.keys(DRAWINGS).map(Number).sort((a, b) => a - b);
}

/**
 * THE TABLE MUST BE COVERED, and this is where that is checked: `src/abi.mjs` owns the icon ids
 * and this file owns the drawings, which is exactly the two-sides-of-one-fact shape the ABI exists
 * to guard. A new id with no drawing would silently fall back to a page icon, and a desktop full
 * of identical generic icons is the kind of defect a screenshot does not make obvious.
 */
export function selfTest() {
  const drawn = drawnIcons();
  const missing = [];
  for (let id = 0; id <= WICON_LIMIT; id += 1) if (!hasIcon(id)) missing.push(id);
  if (missing.length) {
    throw new Error(`icons.mjs selfTest: no drawing for icon id ${missing.join(", ")}`);
  }
  const extra = drawn.filter((id) => id > WICON_LIMIT);
  if (extra.length) {
    throw new Error(`icons.mjs selfTest: drawing for icon id ${extra.join(", ")}, which is past `
      + `WICON_LIMIT ${WICON_LIMIT}`);
  }
  for (let id = 0; id <= WICON_LIMIT; id += 1) {
    if (!ICON_NAME[id]) throw new Error(`icons.mjs selfTest: icon id ${id} has no name`);
  }
  // TWO ICONS OF ONE KIND MUST NOT SHARE A GRADIENT ID, which is the defect `serial` exists for:
  // an id collision in one document makes an icon's fill change when an unrelated icon is removed.
  const a = iconMarkup(WICON_FOLDER);
  const b = iconMarkup(WICON_FOLDER);
  const idsOf = (markup) => [...markup.matchAll(/id="([^"]+)"/g)].map((m) => m[1]);
  const shared = idsOf(a).filter((id) => idsOf(b).includes(id));
  if (shared.length) {
    throw new Error(`icons.mjs selfTest: two icons share the gradient id ${shared.join(", ")}`);
  }
  return { drawn: drawn.length, limit: WICON_LIMIT };
}
