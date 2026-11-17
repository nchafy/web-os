// `/usr`: a read-only filesystem whose bytes come from a provider. THE MOUNT IS ATOMIC — every
// object is read by range at boot and only then is the filesystem built, so a provider at a 404
// fails the mount loudly instead of serving an empty `/usr` (MILESTONES.md M3, control 2). So
// `/usr` costs its whole size in memory, which is not a design for a large read-only volume.

import { SynthFS, relParts } from "./synth.mjs";
import { DIR, FILE, FsError } from "../fs/vfs.mjs";
import { probeProvider, readRange, PROBE, PROVIDERS } from "./providers.mjs";

/** The committed `/usr` layout: a name in the mount, and the provider path it comes from. A new
 *  file is a row here and nothing below. */
export const USR_ENTRIES = Object.freeze([
  Object.freeze({ name: "lib/syscall.mjs", path: "src/libos/syscall.mjs" }),
  Object.freeze({ name: "lib/process.mjs", path: "src/libos/process.mjs" }),
  Object.freeze({ name: "include/abi.mjs", path: "src/abi.mjs" }),
  // THE MOUNT NAME HAS NO EXTENSION and the provider path does: `ls` must not require knowing the
  // implementation language. Mode comes from the mount, 0o555 for every file, which is what makes
  // `SYS_spawn`'s execute check (src/kernel/exec.mjs) pass here and fail on a data file.
  Object.freeze({ name: "bin/sh", path: "src/bin/sh.mjs" }),
  Object.freeze({ name: "bin/ls", path: "src/bin/ls.mjs" }),
  Object.freeze({ name: "bin/cat", path: "src/bin/cat.mjs" }),
  Object.freeze({ name: "bin/echo", path: "src/bin/echo.mjs" }),
  Object.freeze({ name: "bin/wc", path: "src/bin/wc.mjs" }),
  Object.freeze({ name: "bin/head", path: "src/bin/head.mjs" }),
  Object.freeze({ name: "bin/grep", path: "src/bin/grep.mjs" }),
  Object.freeze({ name: "bin/sleep", path: "src/bin/sleep.mjs" }),
  Object.freeze({ name: "bin/kill", path: "src/bin/kill.mjs" }),
  Object.freeze({ name: "bin/ps", path: "src/bin/ps.mjs" }),
  Object.freeze({ name: "bin/true", path: "src/bin/true.mjs" }),
  // `yes` is the system's only endless source, so it is what makes `yes | head -1` expressible.
  Object.freeze({ name: "bin/yes", path: "src/bin/yes.mjs" }),
  Object.freeze({ name: "bin/term", path: "src/bin/term.mjs" }),
]);

/** `/bench`, mounted ONLY under a bench boot (src/kernel/kernel.mjs). `SYS_spawn` loads from the
 *  filesystem, and M4's and M4b's orchestrators spawn their stages BY PATH. */
export const BENCH_ENTRIES = Object.freeze([
  Object.freeze({ name: "m4-fs/program.mjs", path: "bench/m4-fs/program.mjs" }),
  Object.freeze({ name: "m4b-fs/program.mjs", path: "bench/m4b-fs/program.mjs" }),
  Object.freeze({ name: "m5-sh/program.mjs", path: "bench/m5-sh/program.mjs" }),
  Object.freeze({ name: "m6-realm/program.mjs", path: "bench/m6-realm/program.mjs" }),
]);

/** The manifest declares no sizes, so each object is read up to this and the real length is
 *  whatever came back. */
const READ_CEILING = 1024 * 1024;

/**
 * `{ fs, report }`, or a THROW naming the reason — the caller (kernel boot) turns that into a
 * refused mount rather than an empty one. `id` is a key of PROVIDERS, never a URL.
 */
export async function mountProvider({ id, entries = USR_ENTRIES, fetchImpl = fetch } = {}) {
  if (!PROVIDERS[id]) throw new FsError("ENODEV", "", `no provider ${JSON.stringify(id)}`);
  if (!entries.length) {
    // A tree with no rows is indistinguishable from a provider that served nothing.
    throw new FsError("EINVAL", "", `provider ${id} has an empty manifest`);
  }

  // THE CAPABILITY PROBE FIRST, against a real object from the manifest, and never downgraded to a
  // warning: a provider that has stopped honouring `Range` must fail before anything is mounted.
  const probe = await probeProvider(id, entries[0].path, { want: 64, fetchImpl });
  if (!probe.ok) {
    throw new FsError(probe.why === PROBE.UNREACHABLE ? "EIO" : "ENODEV", entries[0].path,
      `provider ${id} failed its capability probe: ${probe.why} (${probe.detail})`);
  }

  // Then every object, in full. One failure refuses the whole mount.
  const files = new Map();
  for (const entry of entries) {
    let bytes;
    try {
      bytes = await readRange(id, entry.path, 0, READ_CEILING, { fetchImpl });
    } catch (error) {
      throw new FsError(error.code || "EIO", entry.path,
        `provider ${id} could not serve ${entry.name}: ${error.message}`);
    }
    files.set(`/${entry.name}`, bytes);
  }

  // The directories the manifest implies: `/usr/lib/syscall.mjs` means `/usr/lib` exists, and a
  // mount serving the file without the directory breaks `ls` and every path walk.
  const dirs = new Set(["/"]);
  for (const rel of files.keys()) {
    const parts = relParts(rel);
    for (let i = 1; i < parts.length; i += 1) dirs.add(`/${parts.slice(0, i).join("/")}`);
  }

  const lookup = (rel) => {
    const key = rel === "/" ? "/" : rel.replace(/\/+$/, "");
    if (dirs.has(key)) return { type: DIR, mode: 0o555 };
    const bytes = files.get(key);
    if (!bytes) return null;
    // 0o555, so the bits agree with the MNT_RO mount rather than inviting a write it refuses.
    return { type: FILE, content: bytes, mode: 0o555 };
  };

  const list = (rel) => {
    const key = rel === "/" ? "/" : rel.replace(/\/+$/, "");
    if (!dirs.has(key)) return null;
    const depth = relParts(key).length;
    const names = new Set();
    for (const path of [...files.keys(), ...dirs]) {
      if (path === key) continue;
      const parts = relParts(path);
      if (parts.length !== depth + 1) continue;
      if (depth > 0 && !path.startsWith(`${key}/`)) continue;
      names.add(parts[depth]);
    }
    return [...names].sort();
  };

  const fs = new SynthFS({ name: "provider", lookup, list, mutErrno: "EROFS" });
  return {
    fs,
    report: {
      provider: id,
      entries: entries.length,
      bytes: [...files.values()].reduce((n, b) => n + b.length, 0),
      probe: probe.why,
      contentRange: probe.contentRange,
    },
  };
}
