// The mount table: longest-prefix resolution of an absolute path to the filesystem that owns it.
//
// PURE, and in src/fs/ for that reason: resolution is a total function over a path string and a
// table, so `fsfuzz.py` drives it without a browser. The table holds filesystem objects that do
// I/O; nothing here calls them, and awaiting one fires the purity lint. The drivers are not here —
// `/proc`, `/dev` and `/usr` read live state, so they live in src/kernel/.

import { FsError, isAbsolute, normalize, splitPath } from "./vfs.mjs";

export const MNT_RO = 1;

/** A closed set, asserted on `add`: a typo in a type string would otherwise mount something that
 *  resolves and then answers nothing. */
export const FS_OPFS = "opfs";
export const FS_TMPFS = "tmpfs";
export const FS_PROC = "proc";
export const FS_DEV = "dev";
export const FS_PROVIDER = "provider";

export const FS_TYPES = Object.freeze([FS_OPFS, FS_TMPFS, FS_PROC, FS_DEV, FS_PROVIDER]);

/** Device numbers start at 1, not 0: `encodeFilestat` writes `BigInt(st.dev || 0)`, so a zero
 *  means "nobody set it", and "every mount reports a distinct non-zero device" — the only thing
 *  that makes this table observable through `stat` — cannot pass for a kernel with no table. */
export const DEV_FIRST = 1;

/** Static at boot: there is no `SYS_mount`, so no process reaches `add`. docs/LEARNING-MODE.md §6:
 *  `mount` must never take a caller-supplied URL. */
export class MountTable {
  #rows = new Map();
  #nextDev = DEV_FIRST;

  /** `at` must be absolute and normalized-stable; `fs` answers for the subtree. The caller does not
   *  choose the device number — two mounts sharing one makes `FST_DEV` useless. */
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
    // "`/` always OPFS" (docs/ABI.md), asserted: every other mount's longest-prefix fallback
    // depends on the root existing and being the real volume.
    if (path === "/" && type !== FS_OPFS) {
      throw new FsError("EINVAL", path, `the root mount must be ${FS_OPFS}, not ${type}`);
    }
    if (path !== "/" && !this.#rows.has("/")) {
      throw new FsError("EINVAL", path, "cannot be mounted before the root");
    }
    if (!fs) throw new FsError("EINVAL", path, "mount has no filesystem");
    const row = Object.freeze({
      path, fs, type, flags: flags | 0, dev: this.#nextDev, readOnly: (flags & MNT_RO) !== 0,
      // Whether a mutation here must be journalled: without it the kernel's one metadata-mutation
      // path would refuse every tmpfs write, or journal records for a volume it did not touch.
      durable: type === FS_OPFS,
    });
    this.#nextDev += 1;
    this.#rows.set(path, row);
    return row;
  }

  /** An exact lookup, not resolution. */
  at(path) {
    return this.#rows.get(normalize(path));
  }

  get root() {
    return this.#rows.get("/");
  }

  /** Deepest first — the order `/proc/mounts` and a `umount` sweep both want. */
  rows() {
    return [...this.#rows.values()].sort((a, b) => splitPath(b.path).length - splitPath(a.path).length);
  }

  get size() {
    return this.#rows.size;
  }

  /** The mount that owns `path`, and the path relative to it.
   *
   *  LONGEST PREFIX ON COMPONENT BOUNDARIES, never on the string: a string prefix puts `/usrlocal`
   *  inside the `/usr` mount, producing a file that reads fine and writes to the wrong volume.
   *  `rel` is absolute and starts at the mount's own root, so a filesystem never sees the path it
   *  was mounted at. */
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

  /** One renderer of read-only, so every kernel write path tests a flag rather than deciding. */
  readOnlyAt(path) {
    return this.resolve(path).mount.readOnly;
  }
}
