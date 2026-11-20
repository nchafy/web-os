// `/usr`: a read-only filesystem whose bytes come from a provider. THE MOUNT IS ATOMIC — every
// object is read by range at boot and only then is the filesystem built, so a provider at a 404
// fails the mount loudly instead of serving an empty `/usr` (MILESTONES.md M3, control 2). So
// `/usr` costs its whole size in memory, which is not a design for a large read-only volume.

import { SynthFS, relParts } from "./synth.mjs";
import { DIR, FILE, FsError } from "../fs/vfs.mjs";
import { probeProvider, readRange, PROBE, PROVIDERS } from "./providers.mjs";

/**
 * The mode a row gets when it does not name one: read and EXECUTE, no write.
 *
 * THE X BIT IS WHAT MAKES `/usr/bin` RUNNABLE, and M10 is why the default is no longer the only
 * mode. `SYS_spawn` asks for execute permission (`src/kernel/exec.mjs`), so a row without it
 * cannot be run — which is exactly right for a data file and exactly wrong for a program. Until
 * M10 every row was a program and the distinction could not be observed; a critic pointed out that
 * `/usr/share/logo.png` had become spawnable, and that the comment on `USR_ENTRIES` claimed the
 * opposite.
 */
const DEFAULT_MODE = 0o555;

/** A data file: readable, NOT executable. `spawn` on one is -EACCES, which is the refusal
 *  `USR_ENTRIES` promises for a file that is not a program. */
export const DATA_MODE = 0o444;

/** The committed `/usr` layout: a name in the mount, and the provider path it comes from. A new
 *  file is a row here and nothing below. */
export const USR_ENTRIES = Object.freeze([
  Object.freeze({ name: "lib/syscall.mjs", path: "src/libos/syscall.mjs" }),
  Object.freeze({ name: "lib/process.mjs", path: "src/libos/process.mjs" }),
  Object.freeze({ name: "include/abi.mjs", path: "src/abi.mjs" }),
  // THE MOUNT NAME HAS NO EXTENSION and the provider path does: `ls` must not require knowing the
  // implementation language. Mode comes from the mount: 0o555 for a PROGRAM and 0o444 for a DATA
  // FILE, which is what makes `SYS_spawn`'s execute check (src/kernel/exec.mjs) pass here and fail
  // on the `share/` rows below. The per-row mode exists because M10 added the first data files and
  // a critic found `spawn /usr/share/logo.png` fetching 146 bytes of PNG to evaluate as a module.
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
  Object.freeze({ name: "bin/winopen", path: "src/bin/winopen.mjs" }),
  Object.freeze({ name: "bin/paint", path: "src/bin/paint.mjs" }),
  Object.freeze({ name: "bin/editor", path: "src/bin/editor.mjs" }),
  // M10: the clipboard from a prompt, a drag SOURCE and a drop TARGET.
  Object.freeze({ name: "bin/clip", path: "src/bin/clip.mjs" }),
  Object.freeze({ name: "bin/files", path: "src/bin/files.mjs" }),
  Object.freeze({ name: "bin/imgview", path: "src/bin/imgview.mjs" }),
  /* `/usr/share`: THE FIRST DATA FILES IN THIS FILESYSTEM, and M10 is why they exist. A typed
   * clipboard has nothing to prove against text a program made up — the claim is that bytes of a
   * format nothing here can decode (a PNG) cross two processes untouched, and that an image a
   * display list CAN draw arrives as pixels rather than as a path. Both need a real file.
   *
   * The mount name keeps its extension where `bin/` drops it, because an extension is how a
   * userland program picks a format (`std.formatForPath`) and `bin/ls` must not have to know a
   * language to run a program. */
  Object.freeze({ name: "share/logo.png", path: "src/share/logo.png", mode: DATA_MODE }),
  Object.freeze({ name: "share/logo.rgba", path: "src/share/logo.rgba", mode: DATA_MODE }),
  Object.freeze({ name: "share/readme.txt", path: "src/share/readme.txt", mode: DATA_MODE }),
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
    // THE MODE IS THE ROW'S, defaulting to the executable one: see DEFAULT_MODE.
    files.set(`/${entry.name}`, { bytes, mode: entry.mode ?? DEFAULT_MODE });
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
    const row = files.get(key);
    if (!row) return null;
    // NO WRITE BIT EITHER WAY, so the bits agree with the MNT_RO mount rather than inviting a
    // write it refuses. The X bit is the row's.
    return { type: FILE, content: row.bytes, mode: row.mode };
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
      bytes: [...files.values()].reduce((n, row) => n + row.bytes.length, 0),
      probe: probe.why,
      contentRange: probe.contentRange,
    },
  };
}
