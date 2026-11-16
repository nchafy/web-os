// `/usr`: a read-only filesystem whose bytes come from a provider.
//
// THE MOUNT IS ATOMIC AND IT HAPPENS AT BOOT. The manifest is fetched, every object in it is read
// by range, and only then is the filesystem built. A lazily-fetching `/usr` would pass its mount
// and fail at the first `open`, and MILESTONES.md M3's second negative control is explicit about
// which of those is wanted: "point a provider at a 404 — the mount must fail loudly, never
// silently serve an empty `/usr`." An empty directory tree is the failure mode, so the mount is
// the thing that refuses.
//
// It also means `/usr` costs its whole size in memory. That is affordable for a manifest of a few
// modules and is NOT a design for a large read-only volume: a real one wants the lazy ranged read
// `providers.mjs` already implements, plus a cache and a description kind that can block on it.
// Recorded here rather than discovered later — the provider interface is ready for it; this mount
// policy is not.

import { SynthFS, relParts } from "./synth.mjs";
import { DIR, FILE, FsError } from "../fs/vfs.mjs";
import { probeProvider, readRange, PROBE, PROVIDERS } from "./providers.mjs";

/**
 * The committed `/usr` layout: a name in the mount, and the provider path it comes from.
 *
 * DATA, like the provider table itself. M5 puts ten programs in `/usr/bin` by adding rows here,
 * not by changing anything below.
 *
 * These are the libos modules a program genuinely loads, which is what makes this a real `/usr`
 * rather than a fixture: a process reaching for its syscall stubs is the first honest consumer a
 * read-only system volume has.
 */
export const USR_ENTRIES = Object.freeze([
  Object.freeze({ name: "lib/syscall.mjs", path: "src/libos/syscall.mjs" }),
  Object.freeze({ name: "lib/process.mjs", path: "src/libos/process.mjs" }),
  Object.freeze({ name: "include/abi.mjs", path: "src/abi.mjs" }),
  // M5's ten programs and the shell. THE MOUNT NAME HAS NO EXTENSION and the provider path does:
  // `/usr/bin/ls` is a program and `src/bin/ls.mjs` is the file this repository keeps it in. A
  // reader typing `ls` must not have to know the implementation language, which is the whole
  // reason the two halves of a row are allowed to differ.
  //
  // Mode comes from the mount, which serves every file 0o555 — readable and executable, not
  // writable. That is what makes `SYS_spawn`'s execute check (src/kernel/exec.mjs) pass here and
  // fail on an ordinary data file.
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
]);

/**
 * `/bench`, mounted ONLY under a bench boot (src/kernel/kernel.mjs).
 *
 * It exists because M5 made `SYS_spawn` load from the filesystem, and M4's and M4b's orchestrators
 * spawn their own stages BY PATH: `/bench/m4-fs/program.mjs`. Mounting the bench tree keeps those
 * path strings resolving, so two already-proved milestones keep their proofs unedited — a proof
 * rewritten to keep passing is not the same proof.
 *
 * A row, not a driver, and the same manifest shape `/usr` uses. These are the only two bench
 * programs that call `SYS_spawn`; the rest are spawned by the page, which has its own loader.
 */
export const BENCH_ENTRIES = Object.freeze([
  Object.freeze({ name: "m4-fs/program.mjs", path: "bench/m4-fs/program.mjs" }),
  Object.freeze({ name: "m4b-fs/program.mjs", path: "bench/m4b-fs/program.mjs" }),
  Object.freeze({ name: "m5-sh/program.mjs", path: "bench/m5-sh/program.mjs" }),
]);

/** How much of an object the mount reads. The manifest declares no sizes, so each object is read
 *  up to its provider's maximum and the real length is whatever came back. */
const READ_CEILING = 1024 * 1024;

/**
 * Mount a provider as a read-only filesystem.
 *
 * Returns `{ fs, report }` on success. THROWS on any failure, with the reason named — the caller
 * (kernel boot) turns that into a refused mount rather than an empty one.
 *
 * @param {object} spec
 * @param {string} spec.id        a key of PROVIDERS — never a URL
 * @param {Array}  spec.entries   the committed manifest
 */
export async function mountProvider({ id, entries = USR_ENTRIES, fetchImpl = fetch } = {}) {
  if (!PROVIDERS[id]) throw new FsError("ENODEV", "", `no provider ${JSON.stringify(id)}`);
  if (!entries.length) {
    // A manifest with no rows would mount a tree that is indistinguishable from a provider that
    // served nothing, which is the exact state the control forbids.
    throw new FsError("EINVAL", "", `provider ${id} has an empty manifest`);
  }

  // THE CAPABILITY PROBE FIRST, against a real object from the manifest. A provider that has
  // stopped honouring `Range` must fail here, before anything is mounted — and the probe's
  // verdict is never downgraded to a warning.
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

  // The directories the manifest implies. `/usr/lib/syscall.mjs` means `/usr/lib` exists, and a
  // mount that served the file without the directory would break `ls` and every path walk.
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
    // 0o555: readable and executable, not writable. `/usr` is a system volume and the mount is
    // MNT_RO, so the bits agree with the mount rather than inviting a write the mount refuses.
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
