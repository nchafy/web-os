// A resolve hook that makes `/src/abi.mjs` mean this repository's `src/abi.mjs`.
//
// WHY IT EXISTS. A program in `src/bin/` is served to a browser and imports `/src/abi.mjs` — a
// ROOT-RELATIVE URL, which is the only spelling that works for a module the kernel loads as a blob
// (`src/kernel/kernel.mjs`). Node resolves that against the filesystem root, so `probe.mjs` cannot
// import a program at all without this. The alternative was a probe that rewrote the import and
// then tested its own rewritten copy, which is the stale-copy dishonesty `CLAUDE.md` names: this
// imports the file that ships.
//
// IT REWRITES NOTHING ELSE. A specifier that does not start with `/src/` is handed straight to the
// next resolver, so a typo in a program's import surfaces as a resolution failure rather than
// silently finding something nearby.
import { pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
/** The repository root: `bench/m20-verbs/` is two levels down. Resolved from this file's own path
 *  rather than from the caller's cwd, which is `scripts/serve.py`'s rule for the same reason. */
const ROOT = join(HERE, "..", "..");

export function resolve(specifier, context, next) {
  if (specifier.startsWith("/src/")) {
    return { url: pathToFileURL(join(ROOT, specifier)).href, shortCircuit: true };
  }
  return next(specifier, context);
}
