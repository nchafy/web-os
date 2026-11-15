// Storage providers: a block-read device behind a table that is DATA, not code.
//
// docs/LEARNING-MODE.md §5: "Adding a provider is a row, not a driver." `/usr` is the first
// consumer, and the reason the table exists before there is a second one is that the alternative
// MILESTONES.md M3 rejected — a bespoke `httpimg` driver now and a general provider table later —
// is the same work twice.
//
// ======================================================================================
// THE SECURITY PROPERTY, because this is the one file in the kernel that reaches the network.
//
// A PROCESS CANNOT SUPPLY A URL. Not "the URL is validated" — there is no path by which a
// process-supplied string becomes a request origin:
//
//   1. There is no SYS_mount. A process cannot mount at all; the table is built at boot.
//   2. `urlFor` takes a provider ID and a filesystem path. The ID selects a committed template
//      whose origin is a literal in this file. The path can only ever fill the `{path}` slot.
//   3. The path is validated component by component — no scheme, no authority, no `..`, no NUL —
//      so it cannot escape the template's origin or climb out of the provider's prefix.
//
// Without that, every process would hold an SSRF primitive: a request issued from the browser's
// network position, which can reach a corporate intranet, a cloud metadata endpoint, or a
// localhost admin port that the process itself cannot. M6 deletes `fetch` from the process realm
// precisely to prevent that (constraint 41), and this file is the other half of the same rule —
// M6 removes the direct route, this one refuses to be an indirect one.
//
// Outbound only. Nothing here listens, and the one local provider points at the page's own origin.
// ======================================================================================

import { FsError } from "../fs/vfs.mjs";
import { NAME_MAX } from "../abi.mjs";

/**
 * The committed provider table.
 *
 * Each row is the five fields docs/LEARNING-MODE.md §5 specifies: an id, a URL template, a range
 * strategy, a maximum object size, and an auth mode. A new provider is a row here and nothing
 * else — no driver, no branch, no new call.
 *
 * MEASURED 2026-11-12 (docs/LEARNING-MODE.md §5), and the reason two of these are present and one
 * named host is absent: `cdn.jsdelivr.net` and `raw.githubusercontent.com` both serve genuine
 * ranged block reads with `Content-Range` and CORS, needing no account and no bucket.
 * `unpkg.com` IGNORES `Range` — it returned 999 B for a 100 B request — so it is unusable as a
 * block device and is deliberately not a row. It is named here so nobody adds it back.
 *
 * `auth: "none"` is the only mode implemented. A row needing a credential would need a decision
 * about where the credential lives that nothing in M3 has made, so the probe refuses any other
 * value rather than ignoring the field.
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
  /**
   * The page's own origin, and the only provider a hermetic check can use.
   *
   * A check that needed the public internet would be a check that fails on a train, and worse, one
   * whose failure says nothing about this code. This row makes `/usr` and the capability probe
   * testable against the harness's own server — which serves genuine `Range` requests — while the
   * two CDN rows above stay in the table as the real default and are probed separately.
   *
   * Relative, so it inherits the document's origin and cannot name another host.
   */
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

/**
 * Every way a path could stop being a path. Checked as a closed list rather than by escaping,
 * because escaping answers "can I make this safe" and this answers "is this a filesystem path".
 */
function checkPath(path) {
  if (typeof path !== "string" || path.length === 0) return "empty";
  if (path.includes("\0")) return "NUL";
  // A scheme or an authority would replace the template's origin outright.
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(path)) return "scheme";
  if (path.startsWith("//")) return "authority";
  if (path.includes("\\")) return "backslash";
  // Percent-encoding is refused rather than decoded: `%2e%2e%2f` is `../` to a server and is not
  // to a naive dot check, and the two readings disagreeing is the whole bug class.
  if (path.includes("%")) return "percent";
  if (path.includes("?") || path.includes("#")) return "query";
  for (const part of path.split("/")) {
    if (part === "" ) continue;
    if (part === "." || part === "..") return "dotdot";
    if (part.length > NAME_MAX) return "component too long";
  }
  return "";
}

/**
 * The URL for one object on one provider. THE ONLY PLACE A REQUEST URL IS CONSTRUCTED.
 *
 * @param {string} id    a key of PROVIDERS. Not a URL, not a template, not a host.
 * @param {string} path  a filesystem path relative to the provider's root.
 */
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

/** What a capability probe reports. A refusal names WHICH capability was missing, because
 *  "the provider failed" sends the next hour in the wrong direction. */
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
 * THE CAPABILITY PROBE (MILESTONES.md M3, proof 2).
 *
 * A ranged GET must come back 206, with a `Content-Range` header, carrying EXACTLY the requested
 * byte count. Each of those is a separate assertion with its own refusal, because they fail
 * independently and for different reasons: `unpkg.com` returns 200 with the whole object, a
 * misconfigured bucket returns 206 with no CORS header, and a proxy can return 206 with more bytes
 * than were asked for.
 *
 * "A provider that silently stops supporting `Range` must fail the build, not degrade a mount."
 * So this returns a verdict and never a fallback — the caller decides, and `mountProvider` below
 * refuses rather than mounting something empty.
 *
 * @param {string} id
 * @param {string} path   an object known to exist on that provider
 * @param {number} want   how many bytes to ask for
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
    // A CORS rejection and a dead host are both a TypeError from fetch and CANNOT be told apart
    // from script — the browser withholds the reason on purpose. Reported as unreachable with the
    // message attached rather than guessed at, because claiming "CORS" for an offline network is
    // the kind of confident wrong diagnosis that costs an afternoon.
    return { ok: false, why: PROBE.UNREACHABLE, detail: String((e && e.message) || e), url };
  }
  if (res.status !== 206) {
    // 200 for a ranged request is the `unpkg` failure exactly: the range was ignored and the whole
    // object is on its way.
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

/**
 * One ranged read. The provider interface's only data operation.
 *
 * Refuses a request past the provider's declared `maxObject` BEFORE issuing it: a row's maximum is
 * part of the committed table, and a read that would exceed it is a configuration error rather
 * than something to discover from a 10 MiB response.
 */
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
  // A 200 means the range was ignored and the whole object arrived. Trimming it would turn a
  // broken provider into a working one and hide exactly what the probe exists to catch.
  if (res.status === 200) {
    throw new FsError("EIO", path, `provider ${id} ignored Range and sent ${body.length} B`);
  }
  return body;
}
