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
// call that creates processes. Constraint 108 records it.
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
 * The I/O worker's view id for the kernel's own loader buffer.
 *
 * NEGATIVE ON PURPOSE. `src/kernel/iocore.mjs` keys registered SABs by pid, pids are monotonic
 * from 1, and a negative key therefore cannot ever be a process's — so a program read cannot
 * land in a process's byte region, and a process cannot name this buffer in any call.
 */
export const EXEC_VIEW_ID = -1;

/**
 * A STATIC, ABSOLUTE import specifier.
 *
 * ABSOLUTE ONLY, which is narrower than the page-spawn loader's pattern, and the narrowness is the
 * point. A program's image is a Blob URL with an opaque path, so a RELATIVE specifier inside it has
 * no base to resolve against — and the file the program came from is a filesystem path, not a URL,
 * so there is no sensible base to invent. `/src/abi.mjs` resolves against the document and comes
 * out as the SAME absolute URL `src/libos/process.mjs` already resolved for its own graph, so the
 * dependency is served out of the process's module map rather than off the network.
 *
 * A program that writes `./x.mjs` therefore keeps the specifier verbatim and fails to load, which
 * is reported as ENOEXEC with the module loader's own message. That is the honest outcome: there
 * is no file for it to mean.
 */
const ABSOLUTE_SPECIFIER = /(\bfrom\s*|\bimport\s*)(["'])(\/[^"']*)\2/g;

/**
 * A RELATIVE path-shaped specifier, which this loader cannot link and REFUSES rather than passes
 * through.
 *
 * MEASURED, and it is why this pattern exists at all. `bench/m4-fs/program.mjs` imported
 * `../../src/abi.mjs`, which the page's URL-based loader resolves and this one cannot. Left
 * verbatim, the blob failed to import inside the child — so every stage of M4's pipelines faulted
 * with SIGABRT and `/proc` said `never issued a syscall`, and 23 expectations in a milestone that
 * was already proved went red with nothing anywhere naming a specifier. A refusal that says
 * "relative specifier `../../src/abi.mjs`" costs one regex and turns that afternoon into a line.
 */
const RELATIVE_SPECIFIER = /(?:\bfrom\s*|\bimport\s*)(["'])(\.{1,2}\/[^"']*)\1/;

/**
 * Rewrite a program's absolute specifiers to absolute URLs. PURE over (text, base).
 *
 * `resolved` is returned rather than assumed so a check can assert the count: a loader that
 * silently stopped rewriting would leave every program importing nothing and failing identically.
 */
export function linkProgram(text, base) {
  const relative = RELATIVE_SPECIFIER.exec(text);
  if (relative) return { code: null, resolved: 0, unlinkable: relative[2] };
  let resolved = 0;
  const code = text.replace(ABSOLUTE_SPECIFIER, (all, lead, quote, specifier) => {
    resolved += 1;
    return `${lead}${quote}${new URL(specifier, base).href}${quote}`;
  });
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
   * CONTENT-ADDRESSED, not path-addressed.
   *
   * A path key would serve a stale image after the file behind it changed, which is exactly what a
   * shell writing a program and running it does. Hashing the bytes means two programs with
   * identical text share one Blob and a rewritten program gets a new one, with no invalidation
   * logic to get wrong. The Blob is never revoked: a process may still be importing it, and the
   * kernel's own lifetime is the bound.
   */
  const images = new Map();
  let loads = 0;
  let cacheHits = 0;
  let bytesRead = 0;
  let durableReads = 0;
  let durableWaits = 0;

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
      const view = ctx.execView();
      const parts = [];
      let total = 0;
      for (;;) {
        const n = await store.readFd(d, EXEC_VIEW_ID, 0, EXEC_CHUNK, total);
        if (n < 0) return n;
        if (n === 0) break;
        // COPIED OUT OF THE SHARED VIEW IMMEDIATELY. `slice` on a Uint8Array over a
        // SharedArrayBuffer returns a non-shared copy; keeping the subarray would alias a buffer
        // the next chunk overwrites.
        parts.push(view.slice(0, n));
        total += n;
        if (total > PROGRAM_MAX) return -EFBIG;
      }
      bytesRead += total;
      const out = new Uint8Array(total);
      let off = 0;
      for (const part of parts) {
        out.set(part, off);
        off += part.length;
      }
      return out;
    } finally {
      // The sync access handle is AN EXCLUSIVE LOCK PER FILE (src/kernel/calls.mjs says what
      // leaking one costs: the file becomes unopenable by anything for the life of the page). A
      // throw on the read path must not keep it.
      await store.closeFd(d);
    }
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
        cacheHits += 1;
        return { ...cached, url: path, reused: true };
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
        bytes: bytes.length,
        resolved,
        hash,
      };
      images.set(key, image);
      loads += 1;
      return { ...image, reused: false };
    },

    /** The loader's own counters, so "the program crossed the wire zero times" is a measurement.
     *  `fetches` is absent deliberately: there is no fetch in this file to count. */
    stats() {
      return { images: images.size, loads, cacheHits, bytesRead, durableReads, durableWaits };
    },
  };
}
