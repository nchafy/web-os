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
 * Split a line into words and operators.
 *
 * A WORD IS A LIST OF SPANS, not a string with a flag. Each span records how it was written —
 * `bare`, `single` or `double` — and that is what makes every expansion rule expressible:
 *
 *   bare    variables expand, globs are live
 *   double  variables expand, globs are NOT
 *   single  nothing expands
 *
 * THE FLAG WAS WRONG AND THE SPANS ARE THE FIX. A per-word `quoted` boolean made ONE quoted
 * character suppress expansion across the whole word, so `echo "$HOME"` printed the literal text
 * `$HOME` and `ls "no"*` did not glob — while this file's own header claimed the opposite. It also
 * lost the distinction a redirection needs: `> '*'` must mean a file called `*`, and with the flag
 * discarded by `parse` it globbed and TRUNCATED an unrelated file.
 *
 * `magic` is computed from the BARE spans only, as typed, before any expansion. That is POSIX: a
 * `*` that arrived from a variable's value is not a glob, so `f='*'; echo $f` prints a star.
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
      // An escaped character is a SINGLE-quoted span of one: it is literal, and it must not be
      // re-read as a glob or a dollar.
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
      operator("&");
      continue;
    }

    if (char === "|" || char === "<" || char === ">") {
      /* `2> f` IS REFUSED, not silently read as the word `2` plus a redirection.
       *
       * This shell has no fd-qualified redirection. With no check, `echo a 2> err` ran
       * `echo a 2` with STDOUT redirected — measured — and `grep -c x f 2> err` ran grep over a
       * file called `2`, which made it prefix every count with a filename and exit 2. A form that
       * means something specific everywhere else must be an error here rather than quietly
       * something else. */
      if (/^\d+$/.test(bare) && spans.length === 0) {
        // The WHOLE operator in the message, so `2>>` does not report itself as `2>`.
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

/** A token from its spans: the raw text, whether any bare span carries a glob, and whether any
 *  span was quoted. `text` is the word AS TYPED with the quotes removed — what a reader sees in a
 *  diagnostic — and is never what gets executed; `expandWord` produces that. */
function wordOf(spans) {
  return {
    spans,
    text: spans.map((s) => s.text).join(""),
    magic: spans.some((s) => s.kind === "bare" && MAGIC.test(s.text)),
    quoted: spans.some((s) => s.kind !== "bare"),
  };
}

/**
 * One word, expanded: tilde, then variables, then job specs — SPAN BY SPAN.
 *
 * PURE. Every input it needs arrives as a callback, so this is the whole of the shell's expansion
 * rules with no filesystem and no job table in sight, and `bench/m5-sh/probe.mjs` checks it under
 * `node`.
 *
 * ORDER AND SCOPE, both of which the span model is what makes expressible:
 *   - the TILDE is only a tilde at the very start of a BARE first span, so `echo a~b` and
 *     `echo "~"` are literal, which is POSIX.
 *   - VARIABLES expand in bare and double spans and not in single ones.
 *   - A JOB SPEC is not expanded here at all: it is a whole word or it is literal, and the caller
 *     turns it into TWO words because that is the only unambiguous spelling — see `jobSpecOf`.
 *   - GLOBS are not expanded here. They need the filesystem, so the caller does it, gated on the
 *     `magic` flag this module computed from the bare spans as typed.
 *
 * @param {object} word a token from `tokenize`
 * @param {object} ops
 * @param {(name: string) => string} [ops.lookup] a variable's value, or ""
 * @param {string} [ops.home] what `~` means
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
 * The job this word names — `%1`, `%%`, `%+` — or null.
 *
 * A JOB SPEC IS A WHOLE UNQUOTED WORD OR IT IS LITERAL. That is bash's rule and it is the one that
 * stops ordinary text being rewritten: expanding `%` anywhere in a word made `cat /tmp/a%20b`
 * answer "no such job" and `echo 100%1` silently become `echo 100<pgid>`. Quoted, `'%1'` is a
 * filename, which is what quoting is for.
 *
 * A PREDICATE AND NOT AN EXPANSION, because the caller does something a string cannot express: a
 * job spec expands to TWO words, `--` and the negative process group (see `src/bin/sh.mjs`).
 */
export function jobSpecOf(word) {
  if (word.quoted || word.spans.length !== 1 || word.spans[0].kind !== "bare") return null;
  const m = /^%([%+]|\d+)$/.exec(word.spans[0].text);
  return m ? m[1] : null;
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
    /* THE WHOLE TOKEN, not its text. Keeping only the string threw away `quoted` and `magic`, and
     * the shell then rebuilt the target as an unquoted word: `echo hi > '*'` globbed and
     * TRUNCATED whatever `*` matched, which is a file the user never named. `> '$x'` and `> '%1'`
     * were the same mistake in two other spellings. */
    if (token.text === "<") stage.in = target;
    else stage.outs.push({ word: target, path: target.text, append: token.text === ">>" });
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
  // A TRAILING SLASH ON `home` IS NOT DOUBLED. With `home` of "/", `~/usr` came out as `//usr` —
  // which the VFS tolerates and every printed path then carried.
  if (word.startsWith("~/")) return home.replace(/\/+$/, "") + word.slice(1);
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
 * limitation rather than a feature (docs/CONSTRAINTS.md 138).
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
  // SPLIT ON WHITESPACE **AND** ON THE OPERATORS, so `ls |c` offers `cat`. Splitting on
  // whitespace alone left `word` as `"|c"`, which matched no command and no path, while
  // `ls | c` worked — this function's own doc promised the word after a `|` is a command
  // position.
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
