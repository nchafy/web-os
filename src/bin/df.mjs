// `df`: how much of the volume is used.
//
// IT CALLS `statfs` AND PUBLISHES NO NUMBER OF ITS OWN. `src/abi.mjs`'s `SFS_*` record is the one
// definition of a filesystem's own figures, and `NAME_MAX` is published there too — CLAUDE.md's
// table says every `statfs` implementation publishes it and none restates 255. So this program
// formats and does not compute: a `df` that multiplied blocks by a block size it had assumed would
// be a second opinion about the volume.
//
// The contract this program is written against is in src/bin/true.mjs.

const NAME = "df";

/** Bytes as a human reads them. Binary units, because a filesystem's own blocks are. */
function human(bytes) {
  const units = ["B", "K", "M", "G", "T"];
  let n = Number(bytes);
  let u = 0;
  while (n >= 1024 && u < units.length - 1) { n /= 1024; u += 1; }
  const text = u === 0 ? String(Math.round(n)) : n.toFixed(n < 10 ? 1 : 0);
  return `${text}${units[u]}`;
}

export function run(env) {
  const std = env.std;
  const { flags, bad } = std.getopt((env.argv || []).slice(1), "h");
  if (bad) {
    return { exit: std.complain(env, NAME, null, `unknown option ${bad}`, std.EXIT_USAGE) };
  }
  const st = env.fs.statfs();
  if (typeof st === "number") {
    return { exit: std.complainErrno(env, NAME, null, st), errno: -st };
  }

  const bsize = Number(st.bsize);
  const blocks = Number(st.blocks);
  const bfree = Number(st.bfree);
  const used = blocks - bfree;
  const total = blocks * bsize;
  const usedBytes = used * bsize;
  const freeBytes = bfree * bsize;
  // A ZERO-BLOCK VOLUME IS NOT 0% FULL, it is unknown — and `used / 0` is NaN, which would print
  // as "NaN%" beside numbers that look fine.
  const pct = blocks > 0 ? Math.round((used / blocks) * 100) : null;
  const fmt = flags.h ? human : (n) => String(Math.round(Number(n) / 1024));
  const head = flags.h ? "Size" : "1K-blocks";
  std.say(env, `Filesystem       ${head.padStart(10)}      Used     Avail  Use%  Mounted on\n`);
  std.say(env, [
    "webos".padEnd(16),
    fmt(total).padStart(10),
    fmt(usedBytes).padStart(10),
    fmt(freeBytes).padStart(10),
    (pct === null ? "   -" : `${pct}%`).padStart(6),
    "  /",
  ].join("") + "\n");
  return {
    exit: 0,
    bsize,
    blocks,
    bfree,
    files: Number(st.files),
    ffree: Number(st.ffree),
    nameMax: Number(st.namemax),
    percentUsed: pct,
  };
}
