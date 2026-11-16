// M5's host probe: the shell's front end and the programs' pure parts, under plain Node.
//
// No browser, no SAB, no kernel. `src/libos/shlex.mjs` is pure by construction — globbing takes
// its directory reads as callbacks — so tokenizing, parsing, expansion, globbing and completion
// are all checkable in milliseconds. What this CANNOT cover is a pipeline: that needs real
// processes and real pipes, and `www/m5.html` drives those.
//
// THE PROGRAMS ARE LOADED THE WAY THE KERNEL LOADS THEM. A program's only legal import is
// `/src/abi.mjs`, an absolute specifier the kernel rewrites against the document
// (src/kernel/exec.mjs `linkProgram`); Node cannot resolve it, so this probe performs the SAME
// rewrite against a file URL and imports the result as a data: URL. That is deliberately the same
// transformation rather than a second one — a probe that patched the source differently from the
// kernel would be checking a program nobody runs.

import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";

import {
  tokenize, parse, expandTilde, expandVars, expandGlob, componentRegex, hasMagic, complete,
  UsageError,
} from "../../src/libos/shlex.mjs";
import { signalOf, SIGNALS, SIGNAL_NAME } from "../../src/abi.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");

const results = [];
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  results.push({ name, ok, got: ok ? undefined : got, want: ok ? undefined : want });
};
const checkThat = (name, ok, detail) =>
  results.push({ name, ok: !!ok, detail: ok ? undefined : detail });
/** What a call threw, as a message — or the sentinel, so "it did not throw" is a visible answer
 *  rather than an undefined that compares equal to a missing expectation. */
const threw = (fn) => {
  try {
    fn();
    return "<no throw>";
  } catch (e) {
    return e instanceof UsageError ? e.message : `unexpected: ${e.message}`;
  }
};

/** One program module, linked the way the kernel links it. */
async function loadProgram(rel) {
  const source = readFileSync(resolve(ROOT, rel), "utf8");
  const base = pathToFileURL(resolve(ROOT, "src/abi.mjs")).href;
  const linked = source.replace(/(["'])\/src\/abi\.mjs\1/g, JSON.stringify(base));
  return import(`data:text/javascript,${encodeURIComponent(linked)}`);
}

/* ---------------------------------------------------------------- words ----------------- */

check("a plain line is words", tokenize("ls -l /usr").map((t) => t.text), ["ls", "-l", "/usr"]);
check("single quotes hold a space", tokenize("echo 'a b'").map((t) => t.text), ["echo", "a b"]);
check("double quotes hold a space", tokenize('echo "a b"').map((t) => t.text), ["echo", "a b"]);
// The predecessor's bug, kept as a check: an escaped quote inside a double-quoted span.
check('an escaped quote does not end the span', tokenize('echo "a\\"b"').map((t) => t.text),
  ["echo", 'a"b']);
check("a backslash escapes a space", tokenize("echo a\\ b").map((t) => t.text), ["echo", "a b"]);
check("a comment is dropped", tokenize("ls # everything").map((t) => t.text), ["ls"]);
check("a pipe is an operator", tokenize("a|b").map((t) => t.text), ["a", "|", "b"]);
check("append is one operator", tokenize("a >> b").map((t) => t.text), ["a", ">>", "b"]);
check("background is an operator", tokenize("sleep 60 &").map((t) => t.text),
  ["sleep", "60", "&"]);

// QUOTING IS PER SPAN, which is what makes both halves of the glob rule work.
check("an unquoted star is magic", tokenize("ls *").map((t) => t.magic), [false, true]);
check("a quoted star is not", tokenize("ls '*'").map((t) => t.magic), [false, false]);
check("a partly quoted word still globs", tokenize('ls "no"*').map((t) => t.magic),
  [false, true]);

check("&& is refused, not read as a word", threw(() => tokenize("mkdir d && echo x")),
  "&& is not supported — one pipeline per line");
check("; is refused", threw(() => tokenize("a; b")), "; is not supported — one pipeline per line");
check("|| is refused", threw(() => tokenize("a || b")),
  "|| is not supported — one pipeline per line");
check("an unterminated single quote is refused", threw(() => tokenize("echo 'a")),
  "unterminated single quote");
check("an unterminated double quote is refused", threw(() => tokenize('echo "a')),
  "unterminated double quote");
check("a trailing backslash is refused", threw(() => tokenize("echo a\\")),
  "unexpected end of line after \\");

/* ---------------------------------------------------------------- pipelines ------------- */

const three = parse("ls /usr/bin | grep c | wc -l");
check("three stages", three.stages.length, 3);
check("stage words survive", three.stages.map((s) => s.words.map((w) => w.text)),
  [["ls", "/usr/bin"], ["grep", "c"], ["wc", "-l"]]);
check("not background", three.background, false);

const bg = parse("sleep 60 &");
check("a trailing & backgrounds the pipeline", bg.background, true);
check("and is not a word", bg.stages[0].words.map((w) => w.text), ["sleep", "60"]);
check("& in the middle is refused", threw(() => parse("sleep 60 & ls")),
  "syntax error: & must end the line");

const redir = parse("sort < in > out >> log");
check("input redirection", redir.stages[0].in, "in");
check("every output target is recorded, in order",
  redir.stages[0].outs, [{ path: "out", append: false }, { path: "log", append: true }]);

check("an empty stage is refused", threw(() => parse("ls |")), "syntax error near |");
check("a leading pipe is refused", threw(() => parse("| ls")), "syntax error near |");
check("a redirection with no command is refused", threw(() => parse("> out")),
  "syntax error: redirection with no command");
check("a redirection with no file is refused", threw(() => parse("ls >")),
  "syntax error: > needs a file");
check("an empty line parses to nothing", parse("   ").stages.length, 0);

/* ---------------------------------------------------------------- expansion ------------- */

check("~ alone is home", expandTilde("~", "/home/u"), "/home/u");
check("~/x is under home", expandTilde("~/x", "/home/u"), "/home/u/x");
check("~other is left alone", expandTilde("~other", "/home/u"), "~other");

const vars = { FOO: "bar", EMPTY: "" };
const look = (n) => (n === "?" ? "7" : n === "$" ? "11" : n === "!" ? "13"
  : (vars[n] === undefined ? "" : vars[n]));
check("$VAR", expandVars("$FOO", look), "bar");
check("${VAR}", expandVars("${FOO}x", look), "barx");
check("an unset variable is empty", expandVars("a${NOPE}b", look), "ab");
check("$? is the status", expandVars("$?", look), "7");
check("$$ is the pid", expandVars("$$", look), "11");
check("$! is the last background pid", expandVars("$!", look), "13");
check("a dollar before nothing is a dollar", expandVars("5$", look), "5$");
check("a dollar before a non-name is a dollar", expandVars("$-", look), "$-");
check("an unterminated brace is refused", threw(() => expandVars("${FOO", look)),
  "unterminated ${");
check("a bad name in braces is refused", threw(() => expandVars("${1x}", look)),
  "bad substitution: ${1x}");

/* ---------------------------------------------------------------- globs ----------------- */

const TREE = {
  "/usr/bin": ["ls", "cat", "grep", "wc", "sh", "echo"],
  "/usr": ["bin", "lib"],
  ".": ["a.txt", "b.txt", "notes", ".hidden"],
  notes: ["one.md"],
};
const ops = {
  list: (dir) => TREE[dir] || null,
  exists: (path) => {
    if (Object.hasOwn(TREE, path)) return true;
    const cut = path.lastIndexOf("/");
    const dir = cut <= 0 ? (cut === 0 ? "/" : ".") : path.slice(0, cut);
    const name = path.slice(cut + 1);
    return (TREE[dir] || []).includes(name);
  },
  isDirectory: (path) => Object.hasOwn(TREE, path),
};

check("hasMagic", [hasMagic("a*"), hasMagic("a?"), hasMagic("a[b]"), hasMagic("plain")],
  [true, true, true, false]);
check("a star matches within one component",
  expandGlob("/usr/bin/c*", ops), ["/usr/bin/cat"]);
check("a relative pattern yields relative paths",
  expandGlob("*.txt", ops), ["a.txt", "b.txt"]);
check("an unmatched pattern comes back as itself",
  expandGlob("*.none", ops), ["*.none"]);
check("a dotfile is not matched by a leading star", expandGlob("*", ops).includes(".hidden"),
  false);
check("a trailing slash means directories only", expandGlob("*/", ops), ["notes/"]);
// The two bracket bugs the predecessor recorded, kept as checks.
check("an unclosed bracket is a literal bracket", componentRegex("[").test("["), true);
check("[]] matches a literal ]", componentRegex("[]]").test("]"), true);
check("a negated class", [componentRegex("[!a]").test("b"), componentRegex("[!a]").test("a")],
  [true, false]);
check("a star does not cross a separator", componentRegex("*").test("a/b"), false);

/* ---------------------------------------------------------------- completion ------------ */

const ctx = {
  commands: () => ["cat", "cd", "ls", "wc"],
  home: "/home/u",
  // THE TRAILING SLASH IS STRIPPED HERE because the real `list` goes through `open(dir,
  // O_DIRECTORY)`, and the VFS's `splitPath` discards empty components — so `/usr/bin/` and
  // `/usr/bin` are the same directory to it. `complete` hands over the directory with the slash
  // the user typed, and a fixture that refused it would be STRICTER than the kernel and would
  // report a failure the real shell does not have.
  list: (dir) => {
    const key = dir === "/" ? "/" : dir.replace(/\/+$/, "");
    const names = TREE[key];
    return names ? names.map((n) => ({ name: n, dir: Object.hasOwn(TREE, n) })) : null;
  },
};
check("a command position completes command names", complete("c", ctx).matches, ["cat", "cd"]);
check("after a pipe is also a command position", complete("ls | ca", ctx).matches, ["cat"]);
check("the prefix is the word being completed", complete("ls | ca", ctx).prefix, "ca");
check("an argument position completes paths",
  complete("cat /usr/bin/c", ctx).matches, ["/usr/bin/cat"]);
check("a directory completes with its slash",
  complete("cd no", ctx).matches, ["notes/"]);
check("an unreadable directory offers nothing",
  complete("cat /nope/x", ctx).matches, []);

/* ---------------------------------------------------------------- signals --------------- */

check("signalOf takes a number", signalOf("9"), SIGNALS.KILL);
check("signalOf takes a name", signalOf("TERM"), SIGNALS.TERM);
check("signalOf takes a SIG-prefixed name", signalOf("SIGINT"), SIGNALS.INT);
check("signalOf is case-insensitive", signalOf("sigint"), SIGNALS.INT);
check("signalOf refuses a non-signal", [signalOf("NOPE"), signalOf("0"), signalOf("")],
  [null, null, null]);
check("every signal names itself back",
  Object.entries(SIGNALS).every(([n, v]) => SIGNAL_NAME[v] === n), true);

/* ---------------------------------------------------------------- the programs ---------- */

const ls = await loadProgram("src/bin/ls.mjs");
const ps = await loadProgram("src/bin/ps.mjs");
const sleep = await loadProgram("src/bin/sleep.mjs");
const std = await import("../../src/libos/std.mjs");

check("a mode word prints as POSIX permissions",
  [ls._modeString(0o040755 | 0), ls._modeString(0o100644), ls._modeString(0o100555)],
  ["drwxr-xr-x", "-rw-r--r--", "-r-xr-xr-x"]);
// Column-major, which is what `ls` does: down the first column, then the second.
check("names lay out down columns",
  ls._columnize(["a", "b", "c", "d"], 10), "a  c\nb  d\n");
check("one name per line when nothing else fits",
  ls._columnize(["aaaaaaaa", "bbbbbbbb"], 8), "aaaaaaaa\nbbbbbbbb\n");
check("no trailing spaces on a short last row",
  ls._columnize(["a", "bb", "c"], 12).split("\n").every((l) => l === l.trimEnd()), true);

check("status fields parse", ps._fields("pid:\t7\nstate:\trunning\n"),
  { pid: "7", state: "running" });
check("a process inside a syscall is S",
  ps._format({ pid: 1, ppid: 0, pgid: 1, state: "running", syscall: 17, cmd: "cat" }).includes("S"),
  true);
check("a computing process is R",
  ps._format({ pid: 1, ppid: 0, pgid: 1, state: "running", syscall: -1, cmd: "x" }).includes("R"),
  true);
check("a zombie is Z",
  ps._format({ pid: 1, ppid: 0, pgid: 1, state: "zombie", syscall: -1, cmd: "x" }).includes("Z"),
  true);

check("sleep takes seconds", sleep.nanosecondsOf("1"), 1000000000);
check("sleep takes a decimal", sleep.nanosecondsOf("0.02"), 20000000);
check("sleep refuses an exponent", sleep.nanosecondsOf("1e9"), null);
check("sleep refuses a word", sleep.nanosecondsOf("banana"), null);
check("sleep refuses a negative", sleep.nanosecondsOf("-1"), null);

/* ---------------------------------------------------------------- std ------------------- */

check("lines does not invent a last empty line", std.lines("a\nb\n"), ["a", "b"]);
check("lines keeps an unterminated last line", std.lines("a\nb"), ["a", "b"]);
check("lines of nothing is nothing", std.lines(""), []);
check("getopt separates flags from operands",
  std.getopt(["-l", "-a", "x", "y"], "la"), { flags: { l: true, a: true }, operands: ["x", "y"], bad: null });
check("getopt bundles flags", std.getopt(["-la"], "la").flags, { l: true, a: true });
check("getopt takes an inline argument", std.getopt(["-n3"], "n:").flags, { n: "3" });
check("getopt takes a separate argument", std.getopt(["-n", "3"], "n:").flags, { n: "3" });
check("getopt reports an unknown flag", std.getopt(["-Q"], "la").bad, "-Q");
check("getopt reports a missing argument", std.getopt(["-n"], "n:").bad, "-n");
check("-- ends the options", std.getopt(["--", "-l"], "l").operands, ["-l"]);
check("a bare - is an operand", std.getopt(["-"], "l").operands, ["-"]);
check("wholeNumber", [std.wholeNumber("10"), std.wholeNumber("x"), std.wholeNumber("-1")],
  [10, null, null]);

const failed = results.filter((r) => !r.ok);
console.log(JSON.stringify({
  ok: failed.length === 0, total: results.length, failed: failed.length, failures: failed,
}, null, 2));
process.exit(failed.length ? 1 : 0);
