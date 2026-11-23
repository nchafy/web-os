// `tail`: the last N lines of each operand, or of standard input.
//
// IT HOLDS A RING AND NOT THE FILE. `head` can stop reading; `tail` cannot know which line is the
// last until the input ends, so the only choice is what it keeps while it reads. A ring of `want`
// lines is bounded by the ANSWER's size rather than the input's, which is what lets
// `yes | head -100000 | tail -2` run in a fixed amount of memory.
//
// The contract this program is written against is in src/bin/true.mjs.

import { MAX_INLINE, O_RDONLY } from "/src/abi.mjs";

const NAME = "tail";

const DEFAULT_LINES = 10;

/** Read all of `fd`, keeping only the last `want` lines, then write them. */
function tailFd(env, fd, want) {
  if (want === 0) return 0;
  const buf = new Uint8Array(MAX_INLINE);
  const ring = new Array(want).fill(null);
  let count = 0;          // how many lines have been completed
  let partial = "";       // bytes since the last newline
  const dec = new TextDecoder();
  for (;;) {
    const n = env.fs.read(fd, buf, 0, buf.length);
    if (n < 0) return n;
    if (n === 0) break;
    // `stream: true` because a multi-byte character can straddle two reads, and decoding each
    // chunk on its own would turn one character into two replacement marks.
    partial += dec.decode(buf.subarray(0, n), { stream: true });
    let at = partial.indexOf("\n");
    while (at >= 0) {
      ring[count % want] = partial.slice(0, at + 1);
      count += 1;
      partial = partial.slice(at + 1);
      at = partial.indexOf("\n");
    }
  }
  partial += dec.decode();
  // A LAST LINE WITH NO NEWLINE IS STILL A LINE, and `tail` must not drop it.
  if (partial.length > 0) {
    ring[count % want] = partial;
    count += 1;
  }
  const first = count > want ? count - want : 0;
  let out = "";
  for (let i = first; i < count; i += 1) out += ring[i % want] || "";
  if (out.length === 0) return 0;
  return env.std.say(env, out) < 0 ? -1 : 0;
}

export function run(env) {
  const std = env.std;
  const args = (env.argv || []).slice(1);
  // `tail -5`, the obsolescent form `head` also accepts, consumed before getopt for its reason.
  let obsolescent = null;
  if (args.length && /^-\d+$/.test(args[0])) {
    obsolescent = args[0].slice(1);
    args.shift();
  }
  const { flags, operands, bad, why } = std.getopt(args, "n:");
  if (bad) {
    const message = why === "missing-argument"
      ? `option ${bad} needs a line count`
      : `unknown option ${bad}`;
    return { exit: std.complain(env, NAME, null, message, std.EXIT_USAGE) };
  }
  if (obsolescent !== null && flags.n === undefined) flags.n = obsolescent;
  let want = DEFAULT_LINES;
  if (flags.n !== undefined) {
    const n = std.wholeNumber(flags.n);
    if (n === null) {
      return { exit: std.complain(env, NAME, null, `bad line count: ${flags.n}`, std.EXIT_USAGE) };
    }
    want = n;
  }

  if (operands.length === 0) {
    const r = tailFd(env, 0, want);
    if (r < 0) return { exit: std.complainErrno(env, NAME, null, r), errno: -r };
    return { exit: 0, lines: want };
  }
  let status = 0;
  for (let i = 0; i < operands.length; i += 1) {
    const path = operands[i];
    const fd = path === "-" ? 0 : env.fs.open(path, O_RDONLY);
    if (fd < 0) { status = std.complainErrno(env, NAME, path, fd); continue; }
    if (operands.length > 1) std.say(env, `${i > 0 ? "\n" : ""}==> ${path} <==\n`);
    const r = tailFd(env, fd, want);
    if (fd !== 0) env.fs.close(fd);
    if (r < 0) status = std.complainErrno(env, NAME, path, r);
  }
  return { exit: status };
}
