// `exec`: a program path becomes a loadable image, out of a mounted filesystem only. Nothing here
// reaches the network, in the one call that creates processes (constraint 123).

import { EFBIG, EIO, EISDIR, ENOEXEC, MAX_INLINE, fnv1a } from "../abi.mjs";
import { FILE } from "../fs/vfs.mjs";
import { errnoOfFsError } from "./store.mjs";
import { resolveMount, credOf } from "./calls.mjs";

/** The largest program this kernel will load. The bytes land in the kernel's own heap and then in
 *  a Blob, so an unbounded program is a process allocating kernel memory. 1 MiB is ~7x the largest
 *  module in this repository (`src/kernel/kernel.mjs`, 73 KiB). */
export const PROGRAM_MAX = 1024 * 1024;

/** One chunk of a durable-volume read. MAX_INLINE, the one buffer size this ABI already agrees on. */
export const EXEC_CHUNK = MAX_INLINE;

/**
 * How many bytes of linked program images the kernel keeps. `PROGRAM_MAX` caps ONE image and this
 * caps their number: without it a process spawning a 1 MiB program in a loop with one byte varied
 * retains a Blob and a blob URL per iteration, constraint 17's failure mode reached through
 * storage. 8 MiB is ~47x the whole of `/usr/bin` as it stands (169 KiB over 14 objects).
 */
export const IMAGE_CACHE_BYTES = 8 * 1024 * 1024;

/** The I/O worker's view id for the kernel's own loader buffer. NEGATIVE ON PURPOSE:
 *  `src/kernel/iocore.mjs` keys registered SABs by pid and pids are monotonic from 1, so a program
 *  read cannot land in a process's byte region and no process can name this buffer. */
export const EXEC_VIEW_ID = -1;

/**
 * THE SPECIFIERS A PROGRAM MAY IMPORT, matched by EQUALITY. Anything else is -ENOEXEC with the
 * specifier named, and `new URL` is never called on process-controlled text (constraint 123).
 *
 * EACH ENTRY MUST ALSO BE IMPORTED BY `src/libos/process.mjs`: a module no process has already
 * imported is fetched once per spawned process, the herd `src/kernel/kernel.mjs` measured losing 6
 * of 480 connections to.
 *
 * A DYNAMIC `import(expr)` computed at run time is catchable by no scanner, this one included
 * (constraint 139). The other half is a Content-Security-Policy on the response that creates the
 * PROCESS REALM; a policy on the document does nothing for a module worker's loader (187, 188).
 */
export const PROGRAM_IMPORTS = Object.freeze(["/src/abi.mjs"]);

/**
 * Every string literal following `from`, `import` or `import(`. The text is walked once, tracking
 * the lexical states a specifier can hide behind, because A COMMENT IS NOT WHITESPACE: a regex
 * wanting only whitespace between the keyword and the quote passes an off-origin specifier hidden
 * behind an empty block comment, with `resolved` 0 rather than an error.
 */
function specifiersIn(text) {
  const found = [];
  let token = "";
  let lastKeyword = "";    // `import` or `from`, if that was the last significant token
  let member = false;      // the identifier is a property access, so it is not the keyword
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    const next = text[i + 1];
    if (c === "/" && next === "/") {
      i = text.indexOf("\n", i + 2);
      if (i < 0) break;
      continue;
    }
    if (c === "/" && next === "*") {
      const end = text.indexOf("*/", i + 2);
      if (end < 0) break;
      i = end + 2;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      let body = "";
      while (j < text.length && text[j] !== c) {
        if (text[j] === "\\") { body += text[j + 1] ?? ""; j += 2; continue; }
        body += text[j];
        j += 1;
      }
      if (lastKeyword) found.push({ at: i, quote: c, raw: text.slice(i, j + 1), specifier: body });
      lastKeyword = "";
      i = j + 1;
      continue;
    }
    // AN IDENTIFIER'S CONTINUATION INCLUDES DIGITS: with the start class used for both, `packI64,`
    // leaves `packI` in the accumulator, the following `} from "…"` becomes the token `packIfrom`,
    // and the real specifier goes unchecked and unrewritten.
    const starts = /[A-Za-z_$]/.test(c);
    if (starts || (token !== "" && /[0-9]/.test(c))) {
      token += c;
      i += 1;
      // The keyword only counts once the identifier has ended, so `imported` is not `import`.
      if (i >= text.length || !/[A-Za-z0-9_$]/.test(text[i])) {
        // A property access is never the keyword, or `Array.from("abc")` is refused as an unknown
        // specifier `abc` — a refusal naming a string the program never imported.
        lastKeyword = !member && (token === "import" || token === "from") ? token : "";
        token = "";
      }
      continue;
    }
    token = "";
    // `import (` and `import(` keep the keyword live; anything else significant clears it.
    if (!/[\s(]/.test(c)) lastKeyword = "";
    member = c === "." || (member && /\s/.test(c));
    i += 1;
  }
  return found;
}

/**
 * Every specifier checked against the allowlist, then rewritten to the absolute URL the libos
 * already has in its module map. `resolved` is the count a check asserts; `unlinkable` names the
 * FIRST refused specifier (constraint 125). Rewriting slices at the scanner's offsets, right to
 * left, so no second pass reintroduces the gap the scanner exists to close.
 */
export function linkProgram(text, base) {
  const found = specifiersIn(text);
  for (const f of found) {
    if (!PROGRAM_IMPORTS.includes(f.specifier)) {
      return { code: null, resolved: 0, unlinkable: f.specifier };
    }
  }
  let code = text;
  for (let k = found.length - 1; k >= 0; k -= 1) {
    const f = found[k];
    const href = new URL(f.specifier, base).href;
    code = code.slice(0, f.at) + f.quote + href + f.quote + code.slice(f.at + f.raw.length);
  }
  return { code, resolved: found.length, unlinkable: "" };
}

/** `fatal` so a file that is not UTF-8 is -ENOEXEC here rather than U+FFFD inside a child that
 *  faults at module load having issued no syscall. */
const DECODER = new TextDecoder("utf-8", { fatal: true });

/**
 * The exec loader. `ctx.mounts`, `ctx.store` and `ctx.execView` are getters because they are built
 * after this is constructed at boot; `ctx.base` is the URL absolute specifiers resolve against.
 */
export function makeExec(ctx) {
  /**
   * CONTENT-ADDRESSED, and THE HASH IS NOT TRUSTED ON ITS OWN: a hit is confirmed by comparing the
   * bytes, because FNV-1a-32 is trivially collidable and the dangerous direction is POISONING — an
   * unprivileged process writes a file whose hash and length match a program in `/usr/bin`, execs
   * it once, and a later `spawn` of the real program by any process runs the attacker's text.
   *
   * The Blob is never revoked while its entry lives: a process may still be importing it.
   */
  const images = new Map();
  let cachedBytes = 0;
  let loads = 0;
  let cacheHits = 0;
  let hashCollisions = 0;
  let evictions = 0;
  let bytesRead = 0;
  let durableReads = 0;
  let durableWaits = 0;

  function sameBytes(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
    return true;
  }

  /** Oldest first, revoking what goes. `keep` is the key just inserted and is never evicted: the
   *  child imports it immediately after `spawn` returns. */
  function evictTo(limit, keep) {
    for (const [key, image] of images) {
      if (cachedBytes <= limit) return;
      if (key === keep) continue;
      URL.revokeObjectURL(image.imageUrl);
      images.delete(key);
      cachedBytes -= image.bytes;
      evictions += 1;
    }
  }

  /** THE LOADER BUFFER IS SHARED AND THE READS ARE ASYNC, so they are serialized here: two
   *  `SYS_spawn` bodies interleaving at their awaits both read into offset 0 of the one SAB the I/O
   *  worker knows about, and each would assemble a mixture of the two programs. */
  let gate = Promise.resolve();

  function locked(body) {
    const run = gate.then(body, body);
    // The chain must not break on a rejection, or every later exec throws something it did not do.
    gate = run.then(() => {}, () => {});
    return run;
  }

  /** The bytes of one program file, or a negative errno. */
  async function readProgram(p, path) {
    const at = resolveMount(p, { mounts: ctx.mounts() }, path);
    if (typeof at === "number") return at;
    let decision;
    try {
      // wantX IS THE EXEC CHECK, run inside the filesystem that owns the file so the mode bits
      // have one implementation (src/fs/vfs.mjs `#may`).
      decision = at.mount.fs.openDecision(credOf(p), at.rel, { wantR: true, wantX: true });
    } catch (error) {
      return errnoOfFsError(error);
    }
    if (decision.type !== FILE) return -EISDIR;

    if (decision.synth) {
      if (decision.bytes.length > PROGRAM_MAX) return -EFBIG;
      bytesRead += decision.bytes.length;
      return decision.bytes;
    }
    if (decision.tmpfs) {
      const size = at.mount.fs.size(decision.ino);
      if (size > PROGRAM_MAX) return -EFBIG;
      const out = new Uint8Array(size);
      try {
        at.mount.fs.read(decision.ino, 0, size, out, 0);
      } catch (error) {
        return errnoOfFsError(error);
      }
      bytesRead += size;
      return out;
    }
    durableReads += 1;
    if (gatePending()) durableWaits += 1;
    return locked(() => readDurable(decision));
  }

  /** A COUNTER'S INPUT, not control flow: how "two execs overlapped and the lock held" becomes a
   *  number a check can assert. */
  let inDurable = false;

  function gatePending() {
    return inDurable;
  }

  /** A program on the OPFS volume, read through the same `Store.readFd` every `read(2)` goes
   *  through: a second reader of a file's extent would hand back bytes above the published size
   *  that nobody committed (src/kernel/store.mjs). */
  async function readDurable(decision) {
    const store = ctx.store();
    // -EIO rather than a throw, the answer `SYS_open` gives for storage it cannot reach.
    if (!store) return -EIO;
    inDurable = true;
    try {
      return await readDurableHeld(store, decision);
    } finally {
      inDurable = false;
    }
  }

  async function readDurableHeld(store, decision) {
    const d = await store.openFd(decision);
    if (typeof d === "number") return d;
    // The fields `Store` expects on a description it did not finish building. No fd is installed.
    d.refs = 1;
    d.pos = 0;
    try {
      /* EVERY CHUNK UNDER ONE INODE LOCK, a correctness requirement: `readFd` takes the lock PER
       * CALL, so a two-chunk read interleaved by another process's `fsync` of the same file splices
       * chunk 0 of generation n to chunk 1 of generation n+1 into a module that exists in no file,
       * then hashes, caches and runs it. `readHeld` is `readFd`'s body without the lock. */
      return await store.withInode(d.ino, () => readChunks(store, d));
    } finally {
      /* `release`, NEVER `closeFd`: `closeFd` commits any non-read-only description, and
       * `commitOnce` with nothing staged publishes the blob's PHYSICAL extent whenever it exceeds
       * the metadata's size — where another description's un-fsynced append lives. That would
       * publish a generation and journal it on behalf of a writer that never called `fsync`.
       *
       * On the throw path too: `openFd` took a handle-row reference, and the sync access handle is
       * AN EXCLUSIVE LOCK PER FILE, so leaking one makes the file unopenable by any process for
       * the life of the page (src/kernel/calls.mjs). */
      if (d.type === "file") await store.withInode(d.ino, () => store.release(d.ino));
    }
  }

  /** Positional reads only, so `d.pos` is never consulted. */
  async function readChunks(store, d) {
    const view = ctx.execView();
    const parts = [];
    let total = 0;
    for (;;) {
      const n = await store.readHeld(d, EXEC_VIEW_ID, 0, EXEC_CHUNK, total);
      if (n < 0) return n;
      if (n === 0) break;
      // `slice` over a SharedArrayBuffer returns a non-shared copy; a subarray would alias a
      // buffer the next chunk overwrites.
      parts.push(view.slice(0, n));
      total += n;
      // Counted before the cap check, unlike the synth and tmpfs arms: this is bytes read off
      // storage, not bytes delivered, so a chunk that trips the cap still cost a read.
      bytesRead += n;
      if (total > PROGRAM_MAX) return -EFBIG;
    }
    const out = new Uint8Array(total);
    let off = 0;
    for (const part of parts) {
      out.set(part, off);
      off += part.length;
    }
    return out;
  }

  return {
    /** Load `path` as a program for process `p`. An image, or a NEGATIVE ERRNO. */
    async load(p, path) {
      const bytes = await readProgram(p, path);
      if (typeof bytes === "number") return bytes;
      if (bytes.length === 0) {
        // An empty file is not a program. Loaded, it arrives at `program.run` as `undefined is not
        // a function`, inside the child.
        return -ENOEXEC;
      }
      const hash = fnv1a(bytes, 0, bytes.length);
      const key = `${hash}:${bytes.length}`;
      const cached = images.get(key);
      if (cached) {
        // A collision is counted and the real bytes are linked instead; losing a hit costs a Blob.
        if (sameBytes(cached.source, bytes)) {
          cacheHits += 1;
          return { ...cached, source: undefined, url: path, reused: true };
        }
        hashCollisions += 1;
        if (ctx.note) {
          ctx.note(`exec ${path}: a cached image has this content hash and different bytes; `
            + "linking the file's own bytes. A deliberate collision is cheap against FNV-1a, so "
            + "this is a refusal to trust the hash and not a storage fault");
        }
      }
      let text;
      try {
        text = DECODER.decode(bytes);
      } catch (error) {
        return -ENOEXEC;
      }
      const { code, resolved, unlinkable } = linkProgram(text, ctx.base);
      if (unlinkable) {
        // ENOEXEC WITH A NAME: unnamed, the only trace is a faulted process that issued no syscall.
        if (ctx.note) {
          ctx.note(`exec ${path}: relative specifier ${JSON.stringify(unlinkable)} cannot be `
            + "linked into a program image — use an absolute specifier such as /src/abi.mjs");
        }
        return -ENOEXEC;
      }
      const image = {
        url: path,
        imageUrl: URL.createObjectURL(new Blob([code], { type: "text/javascript" })),
        // Kept so a later hit can be confirmed rather than believed; also what the ceiling counts.
        source: bytes,
        bytes: bytes.length,
        resolved,
        hash,
      };
      images.set(key, image);
      cachedBytes += image.bytes;
      loads += 1;
      evictTo(IMAGE_CACHE_BYTES, key);
      // `source` is the cache's copy: returning it would put a megabyte in a message.
      return { ...image, source: undefined, reused: false };
    },

    /** `fetches` is absent deliberately: there is no fetch in this file to count. */
    stats() {
      return {
        images: images.size, cachedBytes, loads, cacheHits, bytesRead,
        durableReads, durableWaits,
        // Published because each is a security property invisible when it holds.
        hashCollisions, evictions,
      };
    },
  };
}
