// M21's candidate Bin sidecar: the record that remembers WHERE a deleted thing came from, so a
// restore can put it back. PROPOSED here rather than in src/fs/ because this file is a
// measurement's subject, not yet a shipped codec — `bench/m21-bin/probe.mjs` tears it 10,000 ways
// and reports whether it may ship at all.
//
// PURE over byte arrays, to the same standing rule as src/fs/: no storage API, no clock, no
// random source, nothing async. The whole value of the measurement is that it runs in plain node
// in milliseconds, and a codec that reached for a sync access handle inside its parse path would
// end that (CLAUDE.md, `src/fs/` is pure for a reason that is a standing constraint).
//
// Record layout, a byte string:
//
//   "WB1\n"                      magic. A zero-length or zeroed sidecar fails here, at byte 0
//   <deletedAt>"\n"              milliseconds, decimal digits only
//   <crc32(path)>"\n"            8 lowercase hex, over the PATH BYTES ONLY
//   <path bytes>                 the original absolute path, verbatim, TO THE END OF THE RECORD
//
// Three things about that shape carry the design, and each is a failure it removes:
//
//   THE PATH IS LAST AND UNTERMINATED, so the record needs no delimiter after it and no length
//   field in front of it. `src/fs/vfs.mjs:93`'s `splitPath` forbids exactly one byte in a name —
//   `/` — so a legal filename may contain "\n", "\0" or "%". Any delimiter after the path, and any
//   escape over it, is a second thing that can be wrong about a name the filesystem accepts. A
//   length field would be worse: journal.mjs:14 already names a length as "the field a parser is
//   most dangerous trusting", and here it would also be a second source of truth for a fact the
//   record's own extent already states.
//
//   THE CRC IS OVER THE PATH AND SITS BEFORE IT, which is what makes a TRUNCATED path detectable
//   with no length field. A sidecar cut mid-path is the half-state a tear actually produces, and
//   without the CRC it decodes as a SHORTER PATH THAT LOOKS FINE — so a restore writes the bytes
//   to a prefix of where they came from. That is not a lost restore, it is a restore to the wrong
//   place, and it is the one failure here that corrupts something that was not already broken.
//
//   THE TIME COMES BEFORE THE CRC so that both fixed-alphabet fields are consumed before any byte
//   of the path is read. A decode that had to find the path's end to validate the header could be
//   steered by a newline inside a filename.
//
// The CRC is `crc32` from src/fs/crc32.mjs and not a second checksum: one fact, one definition.

import { crc32 } from "../../src/fs/crc32.mjs";

export const SIDECAR_MAGIC = "WB1\n";

/** A reason, never a bare false — src/fs/journal.mjs's `REFUSE` discipline. A Bin holding one
 *  torn sidecar must still LIST, so every one of these is a row the reader is told about rather
 *  than an exception that takes the whole directory down with it. */
export const SIDECAR_REFUSE = Object.freeze({
  SHORT: "short",
  BAD_MAGIC: "bad-magic",
  SHORT_TIME: "short-time",
  BAD_TIME: "bad-time",
  SHORT_CRC: "short-crc",
  BAD_CRC_FIELD: "bad-crc-field",
  BAD_CRC: "bad-crc",
  EMPTY_PATH: "empty-path",
  RELATIVE_PATH: "relative-path",
});

const ENC = new TextEncoder();
const DEC = new TextDecoder("utf-8", { fatal: false });
const NL = 0x0a;

export function encodeOrigin(path, deletedAt) {
  if (typeof path !== "string" || path === "" || path[0] !== "/") {
    throw new RangeError(`a Bin origin must be an absolute path, got ${JSON.stringify(path)}`);
  }
  if (!Number.isInteger(deletedAt) || deletedAt < 0) {
    throw new RangeError(`deletedAt must be a non-negative integer of milliseconds, got ${deletedAt}`);
  }
  const pathBytes = ENC.encode(path);
  const sum = crc32(pathBytes).toString(16).padStart(8, "0");
  const head = ENC.encode(`${SIDECAR_MAGIC}${deletedAt}\n${sum}\n`);
  const out = new Uint8Array(head.length + pathBytes.length);
  out.set(head, 0);
  out.set(pathBytes, head.length);
  return out;
}

/**
 * @returns {{ok: true, path: string, deletedAt: number}} | {{ok: false, why: string, at: number}}
 *
 * NEVER THROWS and never allocates on the strength of an unvalidated field. A torn sidecar is one
 * unreadable row in the Bin, not an unlistable Bin.
 */
export function decodeOrigin(bytes, opts = {}) {
  const checkCrc = opts.checkCrc !== false;
  if (bytes.length < SIDECAR_MAGIC.length) {
    return { ok: false, why: SIDECAR_REFUSE.SHORT, at: 0 };
  }
  const magic = ENC.encode(SIDECAR_MAGIC);
  for (let i = 0; i < magic.length; i += 1) {
    if (bytes[i] !== magic[i]) return { ok: false, why: SIDECAR_REFUSE.BAD_MAGIC, at: i };
  }
  const nl1 = bytes.indexOf(NL, magic.length);
  if (nl1 < 0) return { ok: false, why: SIDECAR_REFUSE.SHORT_TIME, at: bytes.length };
  const timeField = DEC.decode(bytes.slice(magic.length, nl1));
  if (!/^[0-9]+$/.test(timeField)) {
    return { ok: false, why: SIDECAR_REFUSE.BAD_TIME, at: magic.length };
  }
  const nl2 = bytes.indexOf(NL, nl1 + 1);
  if (nl2 < 0) return { ok: false, why: SIDECAR_REFUSE.SHORT_CRC, at: bytes.length };
  const crcField = DEC.decode(bytes.slice(nl1 + 1, nl2));
  if (!/^[0-9a-f]{8}$/.test(crcField)) {
    return { ok: false, why: SIDECAR_REFUSE.BAD_CRC_FIELD, at: nl1 + 1 };
  }
  const pathBytes = bytes.subarray(nl2 + 1);
  if (pathBytes.length === 0) return { ok: false, why: SIDECAR_REFUSE.EMPTY_PATH, at: nl2 + 1 };
  if (checkCrc && crc32(pathBytes) !== Number.parseInt(crcField, 16)) {
    return { ok: false, why: SIDECAR_REFUSE.BAD_CRC, at: nl2 + 1 };
  }
  if (pathBytes[0] !== 0x2f) {
    return { ok: false, why: SIDECAR_REFUSE.RELATIVE_PATH, at: nl2 + 1 };
  }
  return {
    ok: true,
    path: DEC.decode(pathBytes.slice()),
    deletedAt: Number(timeField),
  };
}

/* ---------------------------------------------------------------------------
   Design D's alternative: NO sidecar, the origin encoded into the Bin entry's
   own NAME. Measured beside the record above because it costs one journal
   record where every sidecar costs two, and the figure that decides it is
   NAME_MAX.
   --------------------------------------------------------------------------- */

/** `/` and `%` percent-escaped, so the result is one legal filename. Every other byte a name may
 *  hold is passed through: `splitPath` forbids only `/`, so escaping more would be escaping
 *  against a rule the filesystem does not have. */
export function encodeInName(path) {
  return [...ENC.encode(path)].map((b) => {
    if (b === 0x2f) return "%2F";
    if (b === 0x25) return "%25";
    return String.fromCharCode(b);
  }).join("");
}

export function decodeFromName(name) {
  const out = [];
  for (let i = 0; i < name.length; i += 1) {
    if (name[i] === "%") {
      const hex = name.slice(i + 1, i + 3);
      if (!/^[0-9A-F]{2}$/.test(hex)) return { ok: false, why: "bad-escape", at: i };
      out.push(Number.parseInt(hex, 16));
      i += 2;
    } else {
      out.push(name.charCodeAt(i) & 0xff);
    }
  }
  const path = DEC.decode(new Uint8Array(out));
  if (path === "" || path[0] !== "/") return { ok: false, why: "relative-path", at: 0 };
  return { ok: true, path };
}
