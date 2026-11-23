// `mv`: rename a file, or move it into a directory.
//
// RENAME AND NOT COPY-THEN-DELETE. `SYS_rename` is O(1) here because the OPFS blob directory is
// flat and named by inode (constraint 26) — the name moves and the bytes do not — so a `mv` built
// out of `cp` and `rm` would turn a pointer swap into a full read and write, and would not be
// atomic. Across a mount boundary a rename cannot work, and the kernel refuses it rather than
// this program silently falling back to a copy that is not what it was asked for.
//
// The contract this program is written against is in src/bin/true.mjs.

import { S_IFMT, S_IFDIR, EXDEV } from "/src/abi.mjs";

const NAME = "mv";

function isDir(env, path) {
  const st = env.fs.stat(path);
  if (typeof st === "number") return false;
  return (st.mode & S_IFMT) === S_IFDIR;
}

function join(dir, name) {
  return dir.endsWith("/") ? `${dir}${name}` : `${dir}/${name}`;
}

function baseName(path) {
  const parts = path.split("/").filter((p) => p.length > 0);
  return parts.length ? parts[parts.length - 1] : path;
}

export function run(env) {
  const std = env.std;
  const { operands, bad } = std.getopt((env.argv || []).slice(1), "");
  if (bad) {
    return { exit: std.complain(env, NAME, null, `unknown option ${bad}`, std.EXIT_USAGE) };
  }
  if (operands.length < 2) {
    return {
      exit: std.complain(env, NAME, null, "needs a source and a destination", std.EXIT_USAGE),
    };
  }
  const dest = operands[operands.length - 1];
  const sources = operands.slice(0, -1);
  const intoDir = isDir(env, dest);
  if (sources.length > 1 && !intoDir) {
    return {
      exit: std.complain(env, NAME, dest, "is not a directory, so it cannot take several sources",
                         std.EXIT_USAGE),
    };
  }

  let status = 0;
  const moved = [];
  for (const from of sources) {
    const to = intoDir ? join(dest, baseName(from)) : dest;
    const r = env.fs.rename(from, to);
    if (r === 0) { moved.push([from, to]); continue; }
    status = r === -EXDEV
      ? std.complain(env, NAME, `${from} -> ${to}`,
                     "crosses a mount boundary, which a rename cannot do; copy it instead")
      : std.complainErrno(env, NAME, `${from} -> ${to}`, r);
  }
  return { exit: status, moved };
}
