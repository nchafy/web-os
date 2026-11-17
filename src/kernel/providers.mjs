// Storage providers: a block-read device behind a table that is DATA, not code.
//
// THE SECURITY PROPERTY, this being the one file in the kernel that reaches the network: A PROCESS
// CANNOT SUPPLY A URL, and there is no path by which a process-supplied string becomes a request
// origin. There is no SYS_mount; the table is built at boot. `urlFor` takes a provider ID that
// selects a committed template whose origin is a literal here, and a path that can only fill the
// `{path}` slot. Otherwise every process would hold an SSRF primitive, issuing requests from the
// browser's network position. M6 deletes `fetch` from the process realm to close the direct route
// (constraint 41); this file refuses to be the indirect one. Outbound only — nothing here listens.

import { FsError } from "../fs/vfs.mjs";
import { NAME_MAX } from "../abi.mjs";

/**
 * The committed provider table: id, URL template, range strategy, maximum object size, auth mode
 * (docs/LEARNING-MODE.md §5). A new provider is a row here and nothing else.
 *
 * MEASURED 2026-11-12 (docs/LEARNING-MODE.md §5): `cdn.jsdelivr.net` and `raw.githubusercontent.com`
 * serve genuine ranged block reads with `Content-Range` and CORS. A host that fails that test
 * belongs in REJECTED_PROVIDERS below.
 *
 * `auth: "none"` is the only mode implemented, and the probe refuses any other value rather than
 * ignoring the field.
 */
export const PROVIDERS = Object.freeze({
  jsdelivr: Object.freeze({
    id: "jsdelivr",
    template: "https://cdn.jsdelivr.net/{path}",
    range: "bytes",
    maxObject: 32 * 1024 * 1024,
    auth: "none",
  }),
  ghraw: Object.freeze({
    id: "ghraw",
    template: "https://raw.githubusercontent.com/{path}",
    range: "bytes",
    maxObject: 32 * 1024 * 1024,
    auth: "none",
  }),
  /** The page's own origin, and the only provider a hermetic check can use. Relative, so it
   *  inherits the document's origin and cannot name another host. */
  local: Object.freeze({
    id: "local",
    template: "/{path}",
    range: "bytes",
    maxObject: 8 * 1024 * 1024,
    auth: "none",
  }),
});

/** Providers that reach the public internet. A probe of one of these is allowed to be
 *  unmeasurable when the network is unreachable; a probe of `local` is not. */
export const REMOTE_PROVIDERS = Object.freeze(["jsdelivr", "ghraw"]);

/** Named so nobody re-adds it: it answered a 100-byte ranged request with 999 bytes. */
export const REJECTED_PROVIDERS = Object.freeze({
  unpkg: "ignores Range: returned 999 B for a 100 B request, measured 2026-11-12",
});

/** Every way a path could stop being a path, as a closed list rather than by escaping: escaping
 *  answers "can I make this safe", this answers "is this a filesystem path". */
function checkPath(path) {
  if (typeof path !== "string" || path.length === 0) return "empty";
  if (path.includes("\0")) return "NUL";
  // A scheme or an authority would replace the template's origin outright.
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(path)) return "scheme";
  if (path.startsWith("//")) return "authority";
  if (path.includes("\\")) return "backslash";
  // Refused, not decoded: `%2e%2e%2f` is `../` to a server and is not to the dot check below.
  if (path.includes("%")) return "percent";
  if (path.includes("?") || path.includes("#")) return "query";
  for (const part of path.split("/")) {
    if (part === "" ) continue;
    if (part === "." || part === "..") return "dotdot";
    if (part.length > NAME_MAX) return "component too long";
  }
  return "";
}

/** THE ONLY PLACE A REQUEST URL IS CONSTRUCTED. `id` is a key of PROVIDERS — not a URL, not a
 *  template, not a host; `path` is relative to the provider's root. */
export function urlFor(id, path) {
  const provider = Object.prototype.hasOwnProperty.call(PROVIDERS, id) ? PROVIDERS[id] : null;
  if (!provider) {
    throw new FsError("ENODEV", "", `no provider ${JSON.stringify(id)}`);
  }
  const bad = checkPath(path);
  if (bad) {
    throw new FsError("EINVAL", path, `a provider path cannot contain ${bad}`);
  }
  const clean = path.replace(/^\/+/, "");
  if (clean === "") throw new FsError("EINVAL", path, "a provider path cannot be empty");
  return provider.template.replace("{path}", clean);
}

/** A refusal names WHICH capability was missing; "the provider failed" names none. */
export const PROBE = Object.freeze({
  OK: "ok",
  STATUS: "bad-status",
  NO_RANGE: "range-ignored",
  NO_CONTENT_RANGE: "no-content-range",
  SHORT: "wrong-byte-count",
  CORS: "cors-blocked",
  UNREACHABLE: "unreachable",
  AUTH: "unsupported-auth",
});

/**
 * THE CAPABILITY PROBE (MILESTONES.md M3, proof 2). A ranged GET must come back 206, with a
 * `Content-Range` header, carrying EXACTLY `want` bytes. Each is a separate assertion with its own
 * refusal because they fail independently. A VERDICT, NEVER A FALLBACK.
 */
export async function probeProvider(id, path, { want = 64, fetchImpl = fetch } = {}) {
  const provider = PROVIDERS[id];
  if (!provider) return { ok: false, why: PROBE.STATUS, detail: `no provider ${id}` };
  if (provider.auth !== "none") {
    return { ok: false, why: PROBE.AUTH, detail: `auth ${provider.auth} is not implemented` };
  }
  const url = urlFor(id, path);
  const last = want - 1;
  let res;
  try {
    res = await fetchImpl(url, { headers: { Range: `bytes=0-${last}` } });
  } catch (e) {
    // A CORS rejection and a dead host are both a TypeError and CANNOT be told apart from script,
    // so this is unreachable-with-the-message rather than a guess at "CORS".
    return { ok: false, why: PROBE.UNREACHABLE, detail: String((e && e.message) || e), url };
  }
  if (res.status !== 206) {
    // 200 is the `unpkg` failure: the range was ignored and the whole object is on its way.
    return {
      ok: false, why: res.status === 200 ? PROBE.NO_RANGE : PROBE.STATUS,
      detail: `status ${res.status}`, url, status: res.status,
    };
  }
  const contentRange = res.headers.get("Content-Range");
  if (!contentRange) {
    return { ok: false, why: PROBE.NO_CONTENT_RANGE, detail: "206 with no Content-Range", url };
  }
  const body = new Uint8Array(await res.arrayBuffer());
  if (body.length !== want) {
    return {
      ok: false, why: PROBE.SHORT, url,
      detail: `asked for ${want} B, got ${body.length} B`, got: body.length, want,
    };
  }
  return { ok: true, why: PROBE.OK, url, contentRange, bytes: body.length };
}

/** One ranged read, the provider interface's only data operation. A request past the provider's
 *  declared `maxObject` is refused BEFORE it is issued. */
export async function readRange(id, path, offset, length, { fetchImpl = fetch } = {}) {
  const provider = PROVIDERS[id];
  if (!provider) throw new FsError("ENODEV", "", `no provider ${id}`);
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new FsError("EINVAL", path, "a negative or unsafe offset");
  }
  if (!Number.isSafeInteger(length) || length <= 0) {
    throw new FsError("EINVAL", path, "a non-positive length");
  }
  if (offset + length > provider.maxObject) {
    throw new FsError("EFBIG", path,
      `${offset + length} B is past provider ${id}'s ${provider.maxObject} B maximum`);
  }
  const url = urlFor(id, path);
  const res = await fetchImpl(url, { headers: { Range: `bytes=${offset}-${offset + length - 1}` } });
  if (res.status !== 206 && res.status !== 200) {
    throw new FsError("EIO", path, `provider ${id} answered ${res.status}`);
  }
  const body = new Uint8Array(await res.arrayBuffer());
  // A 200 means the range was ignored and the whole object arrived. Trimming it would turn a broken
  // provider into a working one.
  if (res.status === 200) {
    throw new FsError("EIO", path, `provider ${id} ignored Range and sent ${body.length} B`);
  }
  return body;
}
