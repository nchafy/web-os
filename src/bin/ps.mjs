// `ps`: the process table, read out of `/proc`.
//
// The contract this program is written against is in src/bin/true.mjs.
//
// THIS PROGRAM HAS NO PRIVILEGE. It opens `/proc`, reads `/proc/<pid>/status` and
// `/proc/<pid>/cmdline`, and formats what it finds — the same three syscalls any program may make.
// The predecessor had no equivalent because it had no process table; there is nothing to port.
//
// WHAT `ps` WITH NO OPTIONS SHOWS is EVERY process, not "processes with the same controlling
// terminal" as POSIX specifies. There is one session and one terminal in this system today, so the
// filter would be a no-op that reads as a feature; `-s` would be the flag to add when a second
// session exists. Said here rather than left as a silent divergence (docs/CONSTRAINTS.md 138).

const NAME = "ps";

/** `key:\tvalue` lines into an object. `/proc/<pid>/status` is written in exactly this shape so it
 *  is greppable without a parser, and this is the parser for the program that wants fields. */
function fields(text) {
  const out = Object.create(null);
  for (const line of text.split("\n")) {
    const cut = line.indexOf(":\t");
    if (cut < 0) continue;
    out[line.slice(0, cut)] = line.slice(cut + 2);
  }
  return out;
}

/** One pid's row, or null when the process went between the listing and the read — which is NOT an
 *  error and is the normal case for a `ps` that ran while something exited. */
function rowOf(env, pid) {
  const status = env.std.readFileText(env, `/proc/${pid}/status`);
  if (typeof status === "number") return null;
  const f = fields(status);
  const cmdline = env.std.readFileText(env, `/proc/${pid}/cmdline`);
  // THE RACE IS HANDLED ON BOTH READS. A pid that exited between the two left a row whose command
  // was `?`, which reads as a live process with an unknown command rather than as one that went.
  if (typeof cmdline === "number") return null;
  // CMDLINE IS NUL-SEPARATED AND NUL-TERMINATED (Linux's own shape), so the trailing empty field
  // is dropped and the rest joined with spaces. Splitting without dropping it printed every
  // command with a trailing space.
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
  // A PARKED PROCESS IS NOT THE SAME AS A RUNNING ONE, and `state` cannot tell them apart —
  // `/proc/<pid>/status` reports `running` for everything that is not a zombie, which is why M4b
  // added the `syscall` field. `S` for a process inside a syscall, `R` for one that is computing,
  // `Z` for a zombie: the three a reader actually wants from this column.
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
  // AN OPERAND IS REFUSED, not discarded. `ps 123` used to list every process and exit 0, which
  // reads as "pid 123 is one of these" — this program takes no operands and says so.
  if (operands.length) {
    return {
      exit: std.complain(env, NAME, operands[0], "ps takes no operands", std.EXIT_USAGE),
    };
  }
  const entries = std.listDir(env, "/proc");
  if (typeof entries === "number") {
    return { exit: std.complainErrno(env, NAME, "/proc", entries), errno: -entries };
  }
  // `/proc` CARRIES `mounts` AS WELL AS THE PIDS, so the numeric names are selected rather than
  // every name taken as a pid. Sorted numerically: a string sort puts pid 10 before pid 2.
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
  // THE ROWS TRAVEL IN THE RESULT as well as to stdout. A proof asserting "ps shows three
  // processes" would otherwise have to parse this program's own column layout out of a pty, and
  // then the proof would be about the padding.
  return { exit: 0, count: rows.length, pids: rows.map((r) => r.pid), rows };
}

/** Exported for the host probe: the two pure functions here. */
export const _fields = fields;
export const _format = format;
