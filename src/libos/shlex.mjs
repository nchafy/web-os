// The shell's language: words, quotes, operators, pipelines, redirections, globs, completion.
// `src/bin/sh.mjs` is the half that makes syscalls.
//
// PURE: nothing here performs a syscall or holds state — globbing takes `list` and `exists`
// callbacks from the caller — so the module runs under `node` with no kernel at all
// (bench/m5-sh/probe.mjs). `&&`, `||` and `;` are REFUSED rather than read as words: read as four
// words, `mkdir d && echo x` makes four directories and reports success. No subshells, functions,
// command substitution or arithmetic.

const MAGIC = /[*?[]/;

export class UsageError extends Error {}

export function hasMagic(word) {
  return MAGIC.test(word);
}

/**
 * Split a line into words and operators.
 *
 * A word is a list of spans, not a string with a flag: each span records how it was written, which
 * is what every expansion rule is expressed against —
 *   bare    variables expand, globs are live
 *   double  variables expand, globs are NOT
 *   single  nothing expands
 * `magic` comes from the bare spans only, as typed: a `*` out of a variable's value is not a glob,
 * so `f='*'; echo $f` prints a star.
 *
 * @returns {{spans: {text: string, kind: string}[], text: string, magic: boolean,
 *            quoted: boolean, operator?: boolean}[]}
 */
export function tokenize(line) {
  const tokens = [];
  /** @type {{text: string, kind: string}[]} */
  let spans = [];
  let bare = "";
  let started = false;

  const flushBare = () => {
    if (bare !== "") spans.push({ text: bare, kind: "bare" });
    bare = "";
  };
  const quotedSpan = (text, kind) => {
    flushBare();
    spans.push({ text, kind });
    started = true;
  };
  const push = () => {
    flushBare();
    if (started) tokens.push(wordOf(spans));
    spans = [];
    started = false;
  };
  const operator = (text) => {
    tokens.push({ spans: [{ text, kind: "bare" }], text, magic: false, quoted: false,
      operator: true });
  };

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];

    if (char === "#" && !started && bare === "") break;

    if (char === "\\") {
      const next = line[i + 1];
      if (next === undefined) throw new UsageError("unexpected end of line after \\");
      // An escaped character is a single-quoted span of one, so it cannot be re-read as a glob.
      quotedSpan(next, "single");
      i += 1;
      continue;
    }

    if (char === "'") {
      const close = line.indexOf("'", i + 1);
      if (close < 0) throw new UsageError("unterminated single quote");
      quotedSpan(line.slice(i + 1, close), "single");
      i = close;
      continue;
    }

    if (char === '"') {
      const span = doubleQuoted(line, i);
      quotedSpan(span.text, "double");
      i = span.end;
      continue;
    }

    if (char === " " || char === "\t") {
      push();
      continue;
    }

    if (char === ";" || (char === "&" && line[i + 1] === "&")) {
      const run = line[i + 1] === char ? char + char : char;
      throw new UsageError(`${run} is not supported — one pipeline per line`);
    }
    if (char === "|" && line[i + 1] === "|") {
      throw new UsageError("|| is not supported — one pipeline per line");
    }

    if (char === "&") {
      push();
      operator("&");
      continue;
    }

    if (char === "|" || char === "<" || char === ">") {
      /* `2> f` is refused, not read as the word `2` plus a redirection: with no check
       * `echo a 2> err` runs `echo a 2`, and `grep -c x f 2> err` greps a file called `2`. */
      if (/^\d+$/.test(bare) && spans.length === 0) {
        // The whole operator in the message, so `2>>` does not report itself as `2>`.
        const op = char === ">" && line[i + 1] === ">" ? ">>" : char;
        throw new UsageError(`${bare}${op} is not supported — this shell has no `
          + "fd-qualified redirection");
      }
      push();
      const double = char === ">" && line[i + 1] === ">";
      operator(double ? ">>" : char);
      if (double) i += 1;
      continue;
    }

    bare += char;
    started = true;
  }
  push();
  return tokens;
}

/** A token from its spans. `text` is the word as typed, for diagnostics; `expandWord` produces
 *  what runs. */
function wordOf(spans) {
  return {
    spans,
    text: spans.map((s) => s.text).join(""),
    magic: spans.some((s) => s.kind === "bare" && MAGIC.test(s.text)),
    quoted: spans.some((s) => s.kind !== "bare"),
  };
}

/**
 * One word, expanded: tilde, then variables — span by span. A tilde counts only at the very start
 * of a bare first span, so `echo a~b` and `echo "~"` are literal. Globs need the filesystem, so
 * the caller expands them, gated on `magic`; `ops.lookup` answers "" for an unset variable.
 */
export function expandWord(word, { lookup = null, home = null } = {}) {
  let out = "";
  for (let i = 0; i < word.spans.length; i += 1) {
    const span = word.spans[i];
    let text = span.text;
    if (span.kind === "bare" && home !== null && i === 0) text = expandTilde(text, home);
    if (span.kind !== "single" && lookup) text = expandVars(text, lookup);
    out += text;
  }
  return out;
}

/**
 * The job this word names — `%1`, `%%`, `%+` — or null. A job spec is a whole unquoted word or it
 * is literal, or `cat /tmp/a%20b` answers "no such job". A predicate rather than an expansion
 * because a job spec expands to two words, which a string cannot express (src/bin/sh.mjs).
 */
export function jobSpecOf(word) {
  if (word.quoted || word.spans.length !== 1 || word.spans[0].kind !== "bare") return null;
  const m = /^%([%+]|\d+)$/.exec(word.spans[0].text);
  return m ? m[1] : null;
}

/** The contents of a double-quoted span, and the index of its closing quote. `\` is honoured before
 *  `"` and `\` only; an `indexOf` scan would stop at an escaped quote and call it unterminated. */
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
 * Group tokens into pipeline stages. `outs` is every `>` and `>>` in the stage, in the order
 * written; `background` is the whole pipeline's, not a stage's.
 *
 * @returns {{stages: {words: object[], outs: {path: string, append: boolean}[], in: string|null}[],
 *            background: boolean}}
 */
export function parse(line) {
  const stages = [];
  let stage = { words: [], outs: [], in: null };
  const tokens = tokenize(line);
  let background = false;
  /* Whether a `|` is still waiting for its right-hand stage. The sweep for an empty stage after
   * the loop cannot catch `ls |`: the trailing empty stage is dropped before it, so the line would
   * run as `ls` — a pipeline missing its last stage becoming a command (constraint 133). */
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
    /* The whole token, not its text: dropping `quoted` and `magic` makes the shell rebuild the
     * target as an unquoted word, so `echo hi > '*'` globs and truncates whatever `*` matched. */
    if (token.text === "<") stage.in = target;
    else stage.outs.push({ word: target, path: target.text, append: token.text === ">>" });
  }

  if (stage.words.length || stage.outs.length || stage.in) {
    if (!stage.words.length) throw new UsageError("syntax error: redirection with no command");
    stages.push(stage);
  } else if (awaitingStage) {
    // `ls |`: the `|` promised another stage and the line ended.
    throw new UsageError("syntax error near |");
  }
  // A stage left empty between two operators, reachable through `a | > f`.
  if (stages.some((each) => !each.words.length)) throw new UsageError("syntax error near |");
  return { stages, background };
}

/** `~` and `~/...` only, which is the whole of this shell's tilde handling. */
export function expandTilde(word, home) {
  if (word === "~") return home;
  // A trailing slash on `home` is not doubled: with `home` of "/", `~/usr` would become `//usr`.
  if (word.startsWith("~/")) return home.replace(/\/+$/, "") + word.slice(1);
  return word;
}

/** `$VAR`, `${VAR}`, `$?`, `$$`, `$!`, in one pass; a `$` before anything that is not a name is a
 *  literal dollar. No word splitting on the result: `$VAR` holding `a b` is ONE argument, which
 *  differs from POSIX because there is no `IFS` here, so quoting a variable changes nothing
 *  (constraint 138). */
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

/** One path component's pattern, as a regex anchored at both ends. `[^/]` rather than `.` for `?`
 *  and `*`, because a component never matches across a separator: `*.txt` is not `notes/a.txt`. */
export function componentRegex(pattern, { ignoreCase = false } = {}) {
  let out = "^";
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i];
    if (char === "*") out += "[^/]*";
    else if (char === "?") out += "[^/]";
    else if (char === "[") {
      const close = pattern.indexOf("]", i + 2);
      if (close < 0) {
        // An unclosed bracket is a literal bracket, not an error: `ls [` is a lookup.
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
    // A bracket body can still be unparseable as a character class — `[a-\]` — and the pattern
    // degrades to a literal. Only a SyntaxError: anything else is not this function's to absorb.
    if (!(error instanceof SyntaxError)) throw error;
    return new RegExp(`^${pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, ignoreCase ? "i" : "");
  }
}

/** One `[...]` body as a JS character class, with the members escaped. A `]` inside the body is a
 *  literal in a glob — which is why the closing-bracket scan starts one character late — but an
 *  unescaped `]` closes a JS class, so `[]]` would compile to `[]` and match nothing. */
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
 * yields relative paths. An unmatched pattern comes back as itself.
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
  // The directories-only constraint is carried here rather than in the component list:
  // `'*/'.split('/')` ends in an empty component that the loop skips, dropping it.
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
 * What the Tab key offers: command names in a command position, paths after it. A command position
 * is the start of a line or the word after a `|`, decided from what precedes the word.
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
  // Split on whitespace AND on the operators, or `word` for `ls |c` is `"|c"` and matches nothing.
  const word = line.split(/[\s|<>]+/).pop();
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
  // A half-typed path names a directory that is not there yet, and a Tab is no place to say so.
  if (!entries) return { matches: [], prefix: word };
  const matches = entries
    .filter((entry) => entry.name.startsWith(stem)
      && (stem.startsWith(".") || !entry.name.startsWith(".")))
    // A directory completes with its slash, so the next Tab continues into it.
    .map((entry) => (cut < 0 ? "" : expanded.slice(0, cut + 1)) + entry.name
      + (entry.dir ? "/" : ""))
    .sort();
  return { matches, prefix: word };
}
