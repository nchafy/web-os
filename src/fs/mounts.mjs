// The mount table: longest-prefix resolution of an absolute path to the filesystem that owns it.
//
// PURE, and in src/fs/ for that reason: resolution is a total function over a path string and a
// table, so `fsfuzz.py` can drive it 10,000 times without a browser. The table HOLDS references to
// filesystem objects, and some of those do I/O — but nothing here calls them. The moment this
// module awaits one of them it stops being a function over its input and the purity lint fires,
// which is the intended alarm.
//
// docs/ABI.md: `mount(src, type, dst, optsB)` / `umount(dst)` — "longest-prefix table, `/` always
// OPFS". The longest-prefix part is the whole of this file. The "`/` always OPFS" part is an
// invariant asserted in `add`, not a comment.
//
// WHAT IS NOT HERE, so a reader does not go looking: the drivers. `/proc` and `/dev` generate
// their content from live kernel state and `/usr` reads it over the network, so both live in
// src/kernel/. This module cannot name them without becoming impure.

import { FsError, isAbsolute, normalize, splitPath } from "./vfs.mjs";

/** The mount flag bits. A flags word rather than booleans so a row stays one integer. */
export const MNT_RO = 1;

/** The filesystem type names a mount row may carry. A closed set, asserted on `add`, because a
 *  typo in a type string would otherwise produce a mount that resolves and then answers nothing. */
export const FS_OPFS = "opfs";
export const FS_TMPFS = "tmpfs";
export const FS_PROC = "proc";
export const FS_DEV = "dev";
export const FS_PROVIDER = "provider";

export const FS_TYPES = Object.freeze([FS_OPFS, FS_TMPFS, FS_PROC, FS_DEV, FS_PROVIDER]);

/**
 * Device numbers start at 1, and that is load-bearing rather than tidy.
 *
 * `abi.mjs`'s `encodeFilestat` writes `BigInt(st.dev || 0)`, so a filesystem that forgot to set
 * `dev` publishes 0. If the root mount were dev 0 the two cases would be the same bytes, and the
 * check "every mount reports a distinct non-zero device" — the only thing that makes the table
 * observable through `stat` at all — would pass for a kernel that had no table. Starting at 1
 * makes a zero in a stat result mean exactly one thing: nobody set it.
 */
export const DEV_FIRST = 1;

/**
 * A longest-prefix mount table.
 *
 * Static at boot for M3: every row is added before the first syscall, and there is no `SYS_mount`.
 * The structure supports a later `mount(2)` — `add` and `remove` are the whole of it — but a
 * process cannot reach them, which is the point. docs/LEARNING-MODE.md §6: `mount` must never take
 * a caller-supplied URL, and the narrowest form of that rule is a process that cannot mount at all.
 */
export class MountTable {
  #rows = new Map();
  #nextDev = DEV_FIRST;

  /**
   * Add a mount. `at` must be absolute and normalized-stable; `fs` is the object that answers for
   * the subtree.
   *
   * Returns the row, with the device number this table assigned. The CALLER does not choose the
   * device number: two mounts sharing one would make `FST_DEV` useless for telling them apart, and
   * a caller-supplied number is a second place that uniqueness would have to be enforced.
   */
  add(at, { fs, type, flags = 0 }) {
    if (typeof at !== "string" || !isAbsolute(at)) {
      throw new FsError("EINVAL", "", `mountpoint must be an absolute path, got ${JSON.stringify(at)}`);
    }
    const path = normalize(at);
    if (this.#rows.has(path)) {
      throw new FsError("EBUSY", path, "already a mountpoint");
    }
    if (!FS_TYPES.includes(type)) {
      throw new FsError("ENODEV", path, `no filesystem type ${JSON.stringify(type)}`);
    }
    // "`/` always OPFS" (docs/ABI.md). Asserted, because the one thing every other mount's
    // longest-prefix fallback depends on is that the root exists and is the real volume.
    if (path === "/" && type !== FS_OPFS) {
      throw new FsError("EINVAL", path, `the root mount must be ${FS_OPFS}, not ${type}`);
    }
    if (path !== "/" && !this.#rows.has("/")) {
      throw new FsError("EINVAL", path, "cannot be mounted before the root");
    }
    if (!fs) throw new FsError("EINVAL", path, "mount has no filesystem");
    const row = Object.freeze({
      path, fs, type, flags: flags | 0, dev: this.#nextDev, readOnly: (flags & MNT_RO) !== 0,
      // WHETHER A MUTATION ON THIS MOUNT HAS TO BE JOURNALLED. True only for the OPFS volume,
      // which is the only filesystem with durable state behind it. Without this the kernel's one
      // metadata-mutation path has no way to tell "applied in memory, nothing to record" from
      // "applied and must be recorded", and it would either refuse every write to a tmpfs or
      // append journal records describing a volume the op did not happen on.
      durable: type === FS_OPFS,
    });
    this.#nextDev += 1;
    this.#rows.set(path, row);
    return row;
  }

  /** The row mounted exactly at `path`, or undefined. Not resolution — an exact lookup. */
  at(path) {
    return this.#rows.get(normalize(path));
  }

  get root() {
    return this.#rows.get("/");
  }

  /** Every row, deepest first. The order is what `/proc/mounts` and a `umount` sweep both want. */
  rows() {
    return [...this.#rows.values()].sort((a, b) => splitPath(b.path).length - splitPath(a.path).length);
  }

  get size() {
    return this.#rows.size;
  }

  /**
   * The mount that owns `path`, and the path relative to it.
   *
   * LONGEST PREFIX ON COMPONENT BOUNDARIES, never on the string. A string prefix would put
   * `/usrlocal` inside the `/usr` mount, and the bug that produces is a file that reads fine and
   * writes to the wrong volume. This walks the components and keeps the deepest exact hit, so
   * `/usrlocal` builds the candidate `/usrlocal`, misses, and falls back to the root.
   *
   * `rel` is always absolute and always starts at the mount's own root, so a filesystem never sees
   * the path it was mounted at and cannot accidentally depend on it.
   */
  resolve(path) {
    if (typeof path !== "string" || !isAbsolute(path)) {
      throw new FsError("EINVAL", "", `resolve needs an absolute path, got ${JSON.stringify(path)}`);
    }
    const root = this.#rows.get("/");
    if (!root) throw new FsError("EINVAL", "/", "the mount table has no root");
    const parts = splitPath(normalize(path));
    let mount = root;
    let depth = 0;
    let probe = "";
    for (let i = 0; i < parts.length; i += 1) {
      probe += `/${parts[i]}`;
      const hit = this.#rows.get(probe);
      if (hit) {
        mount = hit;
        depth = i + 1;
      }
    }
    return { mount, rel: `/${parts.slice(depth).join("/")}` };
  }

  /**
   * Whether `path` lands on a read-only mount. One renderer of that fact, so the kernel's write
   * paths test a mount flag rather than each deciding what read-only means.
   */
  readOnlyAt(path) {
    return this.resolve(path).mount.readOnly;
  }
}
