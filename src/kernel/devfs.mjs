// `/dev`: device files, generated on read, and the one renderer of `/dev/trace`. THE DROPPED-RECORD
// COUNTER IS IN THE HEADER, so a reader cannot obtain the records without the number it is missing.

import { DIR, FILE } from "../fs/vfs.mjs";
import { SynthFS, relParts } from "./synth.mjs";
import { TR_ENTER, TR_EXIT } from "./trace.mjs";
import { ADVANCE_NAME, ADVANCE_TEXT } from "./advance.mjs";
import { SYS_NAME } from "../abi.mjs";

/** A cap: the ring holds 524,288 records and a 65,404-byte inline reply (abi.mjs MAX_INLINE)
 *  cannot carry them. `shown` in the header is how a truncated view says so. */
export const TRACE_RENDER_LIMIT = 256;

const KIND_NAME = { [TR_ENTER]: "enter", [TR_EXIT]: "exit" };

/** A finite file, because this ABI has no short-read protocol for an endless stream. */
const ZERO_BYTES = new Uint8Array(256);

/** The trace as text: seven `key: value` header lines, then one line per record. */
export function renderTrace(ring, { limit = TRACE_RENDER_LIMIT } = {}) {
  if (!ring) return "trace: unavailable\n";
  const before = ring.stats();
  const records = ring.read({ limit });
  const head = [
    `bytes:\t${before.bytes}`,
    `capacity:\t${before.capacity}`,
    `written:\t${before.written}`,
    // Never omitted when zero: a counter that appears only when non-zero is one a reader stops
    // looking for.
    `dropped:\t${before.dropped}`,
    `available:\t${before.available}`,
    `undersized:\t${before.undersized ? 1 : 0}`,
    `shown:\t${records.length}`,
  ];
  const rows = records.map((r) => [
    r.seq, r.pid, r.nr, SYS_NAME[r.nr] ?? "?", KIND_NAME[r.kind] ?? r.kind, r.r0, r.extra,
    r.t.toFixed(3),
  ].join("\t"));
  return `${head.join("\n")}\n${rows.join("\n")}${rows.length ? "\n" : ""}`;
}

/** `ctx.trace` is `() => TraceRing | null`, called per read and never captured.
 *
 *  A ROW IS `{ make, mode, volatile }` AND NOT A BARE FUNCTION, because the mode and the
 *  volatility were two ternaries on the name `trace` — which is a per-row fact written where the
 *  rows are not, and the third row that needed either made that a table. */
export function makeDevFS(ctx) {
  const FILES = {
    // `/dev/trace` is 0o444: a process that could write a kernel log could forge a syscall record.
    // It also grows with every syscall, including this read's, so it publishes no size.
    trace: { mode: 0o444, volatile: true, make: () => renderTrace(ctx.trace()) },
    null: { mode: 0o666, make: () => new Uint8Array(0) },
    zero: { mode: 0o666, make: () => ZERO_BYTES },
    /* M19's ADVANCE TABLE: per-family, per-size glyph widths in SURFACE px, as DATA. It adds no
     * measuring capability to a process realm (constraint 41) — a program reads the numbers that
     * were measured once, and cannot ask for one that was not.
     *
     * 0o444 FOR THE REASON `trace` IS, one step weaker: nothing downstream of a forged advance is
     * privileged, but a process that could rewrite the table could make every OTHER process lay
     * out its columns wrongly, which is not a thing one program may do to another.
     *
     * NOT VOLATILE, and the string is built once in `src/kernel/advance.mjs`: the table cannot
     * change while the kernel runs, so it publishes its real size and a `stat` then a `read` agree
     * — which is what lets a program size one buffer and fill it. */
    [ADVANCE_NAME]: { mode: 0o444, make: () => ADVANCE_TEXT },
  };

  const lookup = (rel) => {
    const parts = relParts(rel);
    if (parts.length === 0) return { type: DIR };
    if (parts.length !== 1) return null;
    // AN OWN-PROPERTY TEST, not a truthiness test: `FILES` inherits Object.prototype, so
    // `FILES["constructor"]` is `Object`, and without this guard `open("/dev/constructor")`
    // snapshots a plain object as the bytes and `read(2)` throws a TypeError out of a handler the
    // dispatcher does not wrap — two syscalls from an unprivileged process faulting the kernel
    // worker.
    if (!Object.prototype.hasOwnProperty.call(FILES, parts[0])) return null;
    const row = FILES[parts[0]];
    if (!row) return null;
    return {
      type: FILE, content: row.make(), mode: row.mode, volatile: row.volatile === true,
    };
  };

  const list = (rel) => (relParts(rel).length === 0 ? Object.keys(FILES) : null);

  // `/dev/console` was here until M7 and is not a name on this filesystem any more: a window is
  // created by `win_create`, not opened by path (constraint 211).
  /* `null` IS THE ONE WRITABLE ROW. `cmd > /dev/null` is the most-used redirection a shell
   * has and it answered EROFS, so `yes > /dev/null` failed at the open. See the `sinks`
   * note in src/kernel/synth.mjs for why this is not the mechanism M7 deleted. */
  return new SynthFS({ name: "dev", lookup, list, mutErrno: "EROFS", sinks: ["null"] });
}
