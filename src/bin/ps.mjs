// `ps`: the process table, read out of `/proc`.
//
// The contract this program is written against is in src/bin/true.mjs.
//
// This program has no privilege: it opens `/proc` and reads two files per pid, the same syscalls
// any program may make.
//
// With no options it shows every process, not those sharing a controlling terminal as POSIX
// specifies. There is one session and one terminal here, so the filter would be a no-op that reads
// as a feature. docs/CONSTRAINTS.md 138.

const NAME = "ps";

/** `key:\tvalue` lines into an object. `/proc/<pid>/status` is written in that shape so it stays
 *  greppable without a parser. */
function fields(text) {
  const out = Object.create(null);
  for (const line of text.split("\n")) {
    const cut = line.indexOf(":\t");
    if (cut < 0) continue;
    out[line.slice(0, cut)] = line.slice(cut + 2);
  }
  return out;
}

/** One pid's row, or null when the process went between the listing and the read. That is not an
 *  error: it is the normal case for a `ps` that ran while something exited. */
function rowOf(env, pid) {
  const status = env.std.readFileText(env, `/proc/${pid}/status`);
  if (typeof status === "number") return null;
  const f = fields(status);
  const cmdline = env.std.readFileText(env, `/proc/${pid}/cmdline`);
  // The race is handled on both reads: a pid that exits between them must drop out, not surface as
  // a live process whose command is `?`.
  if (typeof cmdline === "number") return null;
  // cmdline is NUL-separated and NUL-terminated (Linux's shape), so the trailing empty field is
  // dropped rather than joined into a trailing space.
  const argv = typeof cmdline === "string"
    ? cmdline.split("\0").filter((s) => s !== "")
    : [];
  return {
    pid: Number(f.pid ?? pid),
    ppid: Number(f.ppid ?? 0),
    pgid: Number(f.pgid ?? 0),
    sid: Number(f.sid ?? 0),
    state: f.state || "?",
    calls: Number(f.calls ?? 0),
    syscall: Number(f.syscall ?? -1),
    cmd: argv.length ? argv.join(" ") : "?",
  };
}

const HEAD = "  PID  PPID  PGID STAT CMD";

function format(row) {
  // `state` cannot distinguish parked from running — it reports `running` for everything that is
  // not a zombie — so the column is derived from `syscall`: `S` inside a syscall, `R` computing.
  const stat = row.state === "zombie" ? "Z" : row.syscall >= 0 ? "S" : "R";
  return `${String(row.pid).padStart(5)} ${String(row.ppid).padStart(5)} `
    + `${String(row.pgid).padStart(5)} ${stat.padEnd(4)} ${row.cmd}\n`;
}

export function run(env) {
  const std = env.std;
  const { flags, operands, bad } = std.getopt((env.argv || []).slice(1), "l");
  if (bad) {
    return { exit: std.complain(env, NAME, null, `unknown option ${bad}`, std.EXIT_USAGE) };
  }
  // An operand is refused, not discarded: `ps 123` listing every process and exiting 0 reads as
  // "pid 123 is one of these".
  if (operands.length) {
    return {
      exit: std.complain(env, NAME, operands[0], "ps takes no operands", std.EXIT_USAGE),
    };
  }
  const entries = std.listDir(env, "/proc");
  if (typeof entries === "number") {
    return { exit: std.complainErrno(env, NAME, "/proc", entries), errno: -entries };
  }
  // `/proc` carries `mounts` as well as the pids, so only numeric names are taken. Sorted
  // numerically: a string sort puts pid 10 before pid 2.
  const pids = entries
    .filter((e) => /^\d+$/.test(e.name))
    .map((e) => Number(e.name))
    .sort((a, b) => a - b);

  const rows = [];
  for (const pid of pids) {
    const row = rowOf(env, pid);
    if (row) rows.push(row);
  }
  std.say(env, `${HEAD}\n`);
  for (const row of rows) {
    std.say(env, format(row));
    if (flags.l) {
      std.say(env, `      sid=${row.sid} state=${row.state} calls=${row.calls} `
        + `syscall=${row.syscall}\n`);
    }
  }
  // The rows travel in the result as well as to stdout, so a proof about what `ps` sees does not
  // have to parse this program's column padding out of a pty.
  return { exit: 0, count: rows.length, pids: rows.map((r) => r.pid), rows };
}

/** Exported for the host probe: the two pure functions here. */
export const _fields = fields;
export const _format = format;
