// `/dev`: device files, generated on read, and the one renderer of `/dev/trace`. THE DROPPED-RECORD
// COUNTER IS IN THE HEADER, so a reader cannot obtain the records without the number it is missing.

import { DIR, FILE } from "../fs/vfs.mjs";
import { SynthFS, relParts } from "./synth.mjs";
import { TR_ENTER, TR_EXIT } from "./trace.mjs";
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

/** `ctx.trace` is `() => TraceRing | null`, called per read and never captured. */
export function makeDevFS(ctx) {
  const FILES = {
    trace: () => renderTrace(ctx.trace()),
    null: () => new Uint8Array(0),
    zero: () => ZERO_BYTES,
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
    const make = FILES[parts[0]];
    if (!make) return null;
    // `/dev/trace` is 0o444: a process that could write a kernel log could forge a syscall record.
    const mode = parts[0] === "trace" ? 0o444 : 0o666;
    // `trace` grows with every syscall, including this read's, so it publishes no size.
    return { type: FILE, content: make(), mode, volatile: parts[0] === "trace" };
  };

  const list = (rel) => (relParts(rel).length === 0 ? Object.keys(FILES) : null);

  // `/dev/console` was here until M7 and is not a name on this filesystem any more: a window is
  // created by `win_create`, not opened by path (constraint 211).
  /* `null` IS THE ONE WRITABLE ROW. `cmd > /dev/null` is the most-used redirection a shell
   * has and it answered EROFS, so `yes > /dev/null` failed at the open. See the `sinks`
   * note in src/kernel/synth.mjs for why this is not the mechanism M7 deleted. */
  return new SynthFS({ name: "dev", lookup, list, mutErrno: "EROFS", sinks: ["null"] });
}
