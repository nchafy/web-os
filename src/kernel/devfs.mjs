// `/dev`: three device files, generated on read.
//
// `/dev/trace` is the one M3 is about. `null` and `zero` are here because a `/dev` holding exactly
// one file would make the single file the structure, and the next device would be a rewrite rather
// than a row — the same reason `/proc/<pid>`'s files are a table.
//
// THE DROPPED-RECORD COUNTER IS IN THE HEADER, not in a separate file and not only in a stats
// object the page happens to read. M3's third negative control undersizes the ring and requires
// the counter to go non-zero AND BE DISPLAYED, so a reader of `/dev/trace` cannot obtain the
// records without also obtaining the number of records they are missing.

import { DIR, FILE } from "../fs/vfs.mjs";
import { SynthFS, relParts } from "./synth.mjs";
import { TR_ENTER, TR_EXIT } from "./trace.mjs";
import { SYS_NAME } from "../abi.mjs";

/** How many records one read of `/dev/trace` renders. A cap, because the ring holds 524,288 and a
 *  65,404-byte inline reply (abi.mjs MAX_INLINE) cannot carry them — and a reader that asked for
 *  everything and silently got a prefix is the failure this whole file is written against. */
export const TRACE_RENDER_LIMIT = 256;

const KIND_NAME = { [TR_ENTER]: "enter", [TR_EXIT]: "exit" };

/** 256 zero bytes, allocated once. `/dev/zero`'s content is a fixed-size read here rather than an
 *  endless stream: there is no short-read protocol in this ABI yet, so an honest finite file beats
 *  pretending to be infinite. */
const ZERO_BYTES = new Uint8Array(256);

/**
 * The trace, as text.
 *
 * The header is seven `key: value` lines, then one line per record. `shown` reports how many of
 * `available` were rendered, so a view truncated by the limit says so rather than looking complete.
 */
export function renderTrace(ring, { limit = TRACE_RENDER_LIMIT } = {}) {
  if (!ring) return "trace: unavailable\n";
  const before = ring.stats();
  const records = ring.read({ limit });
  const head = [
    `bytes:\t${before.bytes}`,
    `capacity:\t${before.capacity}`,
    `written:\t${before.written}`,
    // THE NUMBER THE CONTROL IS ABOUT. First class, named, and never omitted when zero: a counter
    // that appears only when non-zero is a counter a reader learns to stop looking for.
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

/**
 * Build the `/dev` filesystem.
 *
 * @param {object} ctx
 * @param {Function} ctx.trace  () => TraceRing | null, called per read
 */
export function makeDevFS(ctx) {
  // Reading /dev/trace does not change it: every reader sees the same window on the recent past,
  // and a `stat` costs nothing. `shown` is how many of `available` this read rendered, so a
  // truncated view is visible as a number rather than inferred from a short answer.
  const FILES = {
    trace: () => renderTrace(ctx.trace()),
    null: () => new Uint8Array(0),
    zero: () => ZERO_BYTES,
  };

  const lookup = (rel) => {
    const parts = relParts(rel);
    if (parts.length === 0) return { type: DIR };
    if (parts.length !== 1) return null;
    const make = FILES[parts[0]];
    if (!make) return null;
    // `/dev/null` and `/dev/zero` are 0o666 because writing to them is the point of them existing,
    // even though the write path refuses a generated filesystem today. `/dev/trace` is 0o444: it
    // is a kernel log, and a process that could write it could forge a syscall record.
    const mode = parts[0] === "trace" ? 0o444 : 0o666;
    return { type: FILE, content: make(), mode };
  };

  const list = (rel) => (relParts(rel).length === 0 ? Object.keys(FILES) : null);

  return new SynthFS({ name: "dev", lookup, list, mutErrno: "EROFS" });
}
