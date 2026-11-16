// The shell's language: words, quotes, operators, pipelines, redirections, globs, completion.
//
// PURE. Nothing here performs a syscall, opens a file or holds state. Globbing needs to read
// directories, so it takes a `list` callback and an `exists` callback and the caller supplies
// them — which is also what makes this module runnable under `node` with no kernel at all
// (bench/m5-sh/probe.mjs is 1 ms and needs no browser). `src/bin/sh.mjs` is the half that makes
// syscalls, and the split is the same one the predecessor had between `shell.mjs` and
// `commands.mjs`: the parser is the part with the edge cases and it is the part that can be
// reasoned about alone.
//
// PORTED, with the measurements that shaped it kept beside the code:
// `../webxp/apps/terminal/shell.mjs` (tokenize, doubleQuoted, parse, expandTilde, complete) and
// `../webxp/apps/terminal/glob.mjs` (hasMagic, componentRegex, charClass, expandGlob). Several of
// the comments below record a bug that was found once already; deleting them would invite it back.
//
// WHAT THIS SHELL'S LANGUAGE IS, and the floor is deliberate rather than unfinished:
//
//     cmd arg 'quoted' "also quoted" | cmd2 -n 3 > file
//     cmd < file >> other
//     cmd &
//     $? $$ $! $VAR ${VAR}
//     %1                       (a job spec, expanded by the shell so `kill %1` works)
//
// WHAT IT IS NOT: no `&&`, no `||`, no `;`, no subshells, no functions, no command substitution,
// no arithmetic. `&&` and `;` are REFUSED rather than read as words, because `mkdir d && echo x`
// is a line people type from habit and reading it as four words made four directories and
// reported success.

/** A word carrying an unquoted glob metacharacter. */
const MAGIC = /[*?[]/;

export class UsageError extends Error {}

export function hasMagic(word) {
  return MAGIC.test(word);
}

/**
 * Split a line into words and operators, reporting which words still carry a glob and which were
 * quoted.
 *
 * Quoting is tracked PER CHARACTER SPAN, not per word, which is what makes both halves of the rule
 * work: `ls '*'` looks for a file called `*`, and `ls "no"*` still expands. A word-wide flag made
 * one quoted character suppress globbing across the whole word.
 *
 * `quoted` is separate from `magic` and is M5's addition: a quoted word must not be variable-
 * expanded by `$`-splitting rules either, and the executor needs to know `''` was a real empty
 * argument rather than a word that vanished.
 *
 * @returns {{text: string, magic: boolean, quoted: boolean, operator?: boolean}[]}
 */
export function tokenize(line) {
  const tokens = [];
  let text = "";
  let magic = false;
  let quoted = false;
  let started = false;

  const push = () => {
    if (started) tokens.push({ text, magic, quoted });
    text = "";
    magic = false;
    quoted = false;
    started = false;
  };

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];

    if (char === "#" && !started) break;

    if (char === "\\") {
      const next = line[i + 1];
      if (next === undefined) throw new UsageError("unexpected end of line after \\");
      text += next;
      quoted = true;
      started = true;
      i += 1;
      continue;
    }

    if (char === "'") {
      const close = line.indexOf("'", i + 1);
      if (close < 0) throw new UsageError("unterminated single quote");
      text += line.slice(i + 1, close);
      quoted = true;
      started = true;
      i = close;
      continue;
    }

    if (char === '"') {
      const span = doubleQuoted(line, i);
      text += span.text;
      quoted = true;
      started = true;
      i = span.end;
      continue;
    }

    if (char === " " || char === "\t") {
      push();
      continue;
    }

    // `&` IS AN OPERATOR AND `&&` IS NOT. One trailing `&` backgrounds the pipeline, which M5's
    // own proof needs (`sleep 60 &`); `&&` is refused rather than taken as a word, for the reason
    // at the head of this file.
    if (char === ";" || (char === "&" && line[i + 1] === "&")) {
      const run = line[i + 1] === char ? char + char : char;
      throw new UsageError(`${run} is not supported — one pipeline per line`);
    }
    if (char === "|" && line[i + 1] === "|") {
      throw new UsageError("|| is not supported — one pipeline per line");
    }

    if (char === "&") {
      push();
      tokens.push({ text: "&", magic: false, quoted: false, operator: true });
      continue;
    }

    if (char === "|" || char === "<" || char === ">") {
      push();
      const double = char === ">" && line[i + 1] === ">";
      tokens.push({ text: double ? ">>" : char, magic: false, quoted: false, operator: true });
      if (double) i += 1;
      continue;
    }

    text += char;
    if (hasMagic(char)) magic = true;
    started = true;
  }
  push();
  return tokens;
}

/**
 * The contents of a double-quoted span, and the index of its closing quote.
 *
 * `\` is honoured, and only before the two characters that are still special inside double quotes.
 * A scan that looked for the next `"` with `indexOf` stopped at an escaped one, so `echo "a\"b"`
 * reported an unterminated quote for a line that has none.
 */
function doubleQuoted(line, open) {
  let text = "";
  let i = open + 1;
  while (i < line.length && line[i] !== '"') {
    if (line[i] === "\\" && (line[i + 1] === '"' || line[i + 1] === "\\")) {
      text += line[i + 1];
      i += 2;
      continue;
    }
    text += line[i];
    i += 1;
  }
  if (i >= line.length) throw new UsageError("unterminated double quote");
  return { text, end: i };
}

/**
 * Group tokens into pipeline stages.
 *
 * `outs` is every `>` and `>>` in the stage, in the order written. A shell OPENS ALL OF THEM —
 * `echo a > f1 > f2` creates `f1` as well — and the last one receives the output. Writing only the
 * last one created neither the file nor a word about it.
 *
 * `background` is the whole pipeline's, not a stage's, and a `&` anywhere but the end is a syntax
 * error: this shell has no `a & b`.
 *
 * @returns {{stages: {words: object[], outs: {path: string, append: boolean}[], in: string|null}[],
 *            background: boolean}}
 */
export function parse(line) {
  const stages = [];
  let stage = { words: [], outs: [], in: null };
  const tokens = tokenize(line);
  let background = false;
  /**
   * WHETHER A `|` IS STILL WAITING FOR ITS RIGHT-HAND STAGE.
   *
   * M5 ADDED THIS, AND IT IS A FIX. The predecessor's comment claimed the check below caught
   * `ls |` — it did not: the trailing empty stage is dropped by the `if` after the loop, so
   * `stages` ended up holding only `ls`, nothing was empty, and the line RAN AS `ls`. A pipeline
   * missing its last stage silently became a command. The host probe
   * (bench/m5-sh/probe.mjs, "an empty stage is refused") is what found it.
   */
  let awaitingStage = false;

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (background) throw new UsageError("syntax error: & must end the line");
    if (!token.operator) {
      awaitingStage = false;
      stage.words.push(token);
      continue;
    }
    if (token.text === "&") {
      if (!stage.words.length) throw new UsageError("syntax error near &");
      background = true;
      continue;
    }
    if (token.text === "|") {
      if (!stage.words.length) throw new UsageError("syntax error near |");
      stages.push(stage);
      stage = { words: [], outs: [], in: null };
      awaitingStage = true;
      continue;
    }
    const target = tokens[i + 1];
    if (!target || target.operator) {
      throw new UsageError(`syntax error: ${token.text} needs a file`);
    }
    i += 1;
    if (token.text === "<") stage.in = target.text;
    else stage.outs.push({ path: target.text, append: token.text === ">>" });
  }

  if (stage.words.length || stage.outs.length || stage.in) {
    if (!stage.words.length) throw new UsageError("syntax error: redirection with no command");
    stages.push(stage);
  } else if (awaitingStage) {
    // `ls |`: the `|` promised another stage and the line ended. Caught HERE, because the empty
    // stage is not in `stages` to be noticed by the sweep below — see `awaitingStage`.
    throw new UsageError("syntax error near |");
  }
  // A stage left empty between two operators. Reachable through `a | > f`, which pushes a stage
  // carrying a redirection and no command.
  if (stages.some((each) => !each.words.length)) throw new UsageError("syntax error near |");
  return { stages, background };
}

/** `~` and `~/...` only, which is the whole of this shell's tilde handling. */
export function expandTilde(word, home) {
  if (word === "~") return home;
  if (word.startsWith("~/")) return home + word.slice(1);
  return word;
}

/**
 * `$VAR`, `${VAR}`, `$?`, `$$`, `$!`, in one pass.
 *
 * AN UNSET VARIABLE EXPANDS TO THE EMPTY STRING, which is POSIX and is also the behaviour that
 * makes `cmd $EXTRA` safe to write. A `$` before anything that is not a name is a literal dollar
 * sign, so `echo 5$` and `echo $-` print what they look like.
 *
 * NO WORD SPLITTING ON THE RESULT. `$VAR` holding `a b` is ONE argument here, which differs from
 * POSIX and is said rather than left to be discovered: this shell has no `IFS`, and splitting
 * without one would be a rule nobody could turn off. Quoting a variable therefore changes nothing,
 * which is the whole class of shell bug that convention exists to prevent — recorded as a known
 * limitation rather than a feature (docs/CONSTRAINTS.md 113).
 */
export function expandVars(word, lookup) {
  let out = "";
  for (let i = 0; i < word.length; i += 1) {
    if (word[i] !== "$") { out += word[i]; continue; }
    const next = word[i + 1];
    if (next === undefined) { out += "$"; continue; }
    if (next === "{") {
      const close = word.indexOf("}", i + 2);
      if (close < 0) throw new UsageError("unterminated ${");
      const name = word.slice(i + 2, close);
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        throw new UsageError(`bad substitution: \${${name}}`);
      }
      out += lookup(name);
      i = close;
      continue;
    }
    if (next === "?" || next === "$" || next === "!") {
      out += lookup(next);
      i += 1;
      continue;
    }
    const rest = /^[A-Za-z_][A-Za-z0-9_]*/.exec(word.slice(i + 1));
    if (!rest) { out += "$"; continue; }
    out += lookup(rest[0]);
    i += rest[0].length;
  }
  return out;
}

/**
 * One path component's pattern, as a regular expression anchored at both ends.
 *
 * `[^/]` rather than `.` for `?` and `*`, because a pattern component never matches across a
 * separator: `*.txt` must not match `notes/a.txt`.
 */
export function componentRegex(pattern, { ignoreCase = false } = {}) {
  let out = "^";
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i];
    if (char === "*") out += "[^/]*";
    else if (char === "?") out += "[^/]";
    else if (char === "[") {
      const close = pattern.indexOf("]", i + 2);
      if (close < 0) {
        // An unclosed bracket is a LITERAL bracket. A shell does not refuse the line for it, and
        // refusing here would make `ls [` an error instead of a lookup.
        out += "\\[";
        continue;
      }
      out += charClass(pattern.slice(i + 1, close));
      i = close;
    } else out += char.replace(/[.+^${}()|\\\]]/g, "\\$&");
  }
  try {
    return new RegExp(`${out}$`, ignoreCase ? "i" : "");
  } catch (error) {
    // A bracket body can still be unparseable as a character class — `[a-\]` is the short one.
    // The whole pattern degrades to a literal, which is the same answer the unclosed-bracket case
    // above gives. Only a pattern that will not compile: anything else thrown here is not this
    // function's to absorb.
    if (!(error instanceof SyntaxError)) throw error;
    return new RegExp(`^${pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, ignoreCase ? "i" : "");
  }
}

/**
 * One `[...]` body as a JS character class.
 *
 * The members are ESCAPED rather than passed through. A `]` inside the body is a literal in a glob
 * — `[]]` matches `]`, which is why the scan for the closing bracket starts one character late —
 * but an unescaped `]` closes a JS class, so `[]]` compiled to the empty class `[]`: it matched
 * nothing, threw nothing, and left a file called `]` unfindable.
 */
function charClass(body) {
  const negated = body.startsWith("!");
  const members = negated ? body.slice(1) : body;
  return `[${negated ? "^" : ""}${members.replace(/[\]\\^]/g, "\\$&")}]`;
}

function joinPrefix(prefix, part) {
  if (prefix === "") return part;
  if (prefix.endsWith("/")) return prefix + part;
  return `${prefix}/${part}`;
}

/**
 * Expand one pattern against a filesystem, keeping the shape the user typed: a relative pattern
 * yields relative paths.
 *
 * AN UNMATCHED PATTERN COMES BACK AS ITSELF, which is the default a shell has. `ls *.none` then
 * reports "no such file" naming the pattern, instead of silently listing everything.
 *
 * @param {string} pattern
 * @param {object} fsops
 * @param {(dir: string) => string[]|null} fsops.list    names in a directory, or null if unreadable
 * @param {(path: string) => boolean} fsops.exists       whether a name is there at all
 * @param {(path: string) => boolean} fsops.isDirectory
 */
export function expandGlob(pattern, fsops) {
  if (!hasMagic(pattern)) return [pattern];
  let prefixes = [pattern.startsWith("/") ? "/" : ""];
  // A trailing separator is the directories-only constraint, and it is carried here rather than
  // left in the component list: `'*/'.split('/')` ends in an empty component, which is skipped,
  // which dropped the constraint and let `echo */` answer with regular files.
  const directoriesOnly = pattern.endsWith("/");

  for (const part of pattern.split("/")) {
    if (part === "") continue;
    const next = [];
    if (!hasMagic(part)) {
      for (const prefix of prefixes) next.push(joinPrefix(prefix, part));
    } else {
      const regex = componentRegex(part);
      for (const prefix of prefixes) {
        const names = fsops.list(prefix || ".");
        // A component that is not a readable directory contributes no matches, which is also what
        // a shell does.
        if (!names) continue;
        for (const name of [...names].sort()) {
          // A leading dot has to be asked for by name, or `rm *` would take the dotfiles.
          if (name.startsWith(".") && !part.startsWith(".")) continue;
          if (regex.test(name)) next.push(joinPrefix(prefix, name));
        }
      }
    }
    prefixes = next;
  }

  const matches = directoriesOnly
    ? prefixes.filter((path) => fsops.isDirectory(path)).map((path) => `${path}/`)
    : prefixes.filter((path) => fsops.exists(path));
  return matches.length ? matches : [pattern];
}

/**
 * What the Tab key offers: command names in a command position, paths after it.
 *
 * A command position is the start of a line or the word after a `|`, so `ls | ca` offers `cat`.
 * Decided from what PRECEDES the word rather than from its index: the first word of the line is
 * not the only place a command name goes.
 *
 * @param {string} line
 * @param {object} ctx
 * @param {() => string[]} ctx.commands             every name in PATH, plus the builtins
 * @param {(dir: string) => {name: string, dir: boolean}[]|null} ctx.list
 * @param {string} ctx.home
 * @returns {{matches: string[], prefix: string}} `prefix` is the word being completed, so the
 *          caller can replace exactly that much of the line.
 */
export function complete(line, ctx) {
  const word = line.split(/\s+/).pop();
  const before = line.slice(0, line.length - word.length);

  if (/(^|\|)\s*$/.test(before)) {
    const matches = ctx.commands().filter((name) => name.startsWith(word)).sort();
    return { matches, prefix: word };
  }

  const expanded = expandTilde(word, ctx.home);
  const cut = expanded.lastIndexOf("/");
  const dir = cut < 0 ? "." : expanded.slice(0, cut + 1) || "/";
  const stem = cut < 0 ? expanded : expanded.slice(cut + 1);
  const entries = ctx.list(dir);
  // A half-typed path names a directory that is not there yet, and a Tab is not the place to
  // report it.
  if (!entries) return { matches: [], prefix: word };
  const matches = entries
    .filter((entry) => entry.name.startsWith(stem)
      && (stem.startsWith(".") || !entry.name.startsWith(".")))
    // A directory completes WITH ITS SLASH, so the next Tab continues into it.
    .map((entry) => (cut < 0 ? "" : expanded.slice(0, cut + 1)) + entry.name
      + (entry.dir ? "/" : ""))
    .sort();
  return { matches, prefix: word };
}
