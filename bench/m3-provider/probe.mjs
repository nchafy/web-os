// The provider table under Node, with a stub fetch. No network.
//
// THE SUBJECT IS THE SSRF REFUSAL. `urlFor` is the only place a request URL is built, so every way
// a path could escape the committed template's origin is tested here by asserting the refusal
// CODE, not just that something threw.
import {
  PROVIDERS, REMOTE_PROVIDERS, REJECTED_PROVIDERS, urlFor, probeProvider, readRange, PROBE,
} from "../../src/kernel/providers.mjs";

const results = [];
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  results.push({ name, ok, got: ok ? undefined : got, want: ok ? undefined : want });
};
const checkThat = (name, ok, detail) => results.push({ name, ok: !!ok, detail: ok ? undefined : detail });
const code = (fn) => { try { fn(); return "<no throw>"; } catch (e) { return e.code || e.message; } };

// ---- the table is data ------------------------------------------------------------------
check("three providers are committed", Object.keys(PROVIDERS).sort(), ["ghraw", "jsdelivr", "local"]);
checkThat("every row carries the five declared fields",
  Object.values(PROVIDERS).every((r) =>
    r.id && r.template && r.range && typeof r.maxObject === "number" && r.auth),
  Object.values(PROVIDERS));
checkThat("every row is frozen, so a caller cannot retarget one",
  Object.values(PROVIDERS).every(Object.isFrozen) && Object.isFrozen(PROVIDERS), "a row was mutable");
checkThat("unpkg is recorded as rejected, with the measurement",
  REJECTED_PROVIDERS.unpkg.includes("999"), REJECTED_PROVIDERS);
checkThat("unpkg is not a usable row", PROVIDERS.unpkg === undefined, "unpkg came back");
check("the remote providers are named", [...REMOTE_PROVIDERS].sort(), ["ghraw", "jsdelivr"]);

// ---- urlFor: the happy path -------------------------------------------------------------
check("a provider id plus a path makes a URL", urlFor("jsdelivr", "npm/pkg@1/file.js"),
  "https://cdn.jsdelivr.net/npm/pkg@1/file.js");
check("a leading slash is absorbed, not doubled", urlFor("jsdelivr", "/npm/a"),
  "https://cdn.jsdelivr.net/npm/a");
check("the local provider stays relative to the page origin", urlFor("local", "www/m3.html"),
  "/www/m3.html");

// ---- THE SSRF REFUSALS ------------------------------------------------------------------
// Each of these is a way a process-supplied string could have become a request origin.
for (const [what, path] of [
  ["an absolute http URL", "http://evil.example/x"],
  ["an absolute https URL", "https://evil.example/x"],
  ["a protocol-relative authority", "//evil.example/x"],
  ["a file: URL", "file:///etc/passwd"],
  ["a data: URL", "data:text/plain,x"],
  ["a javascript: URL", "javascript:alert(1)"],
  ["a dotdot escape", "../../../etc/passwd"],
  ["a dotdot in the middle", "npm/../../etc/passwd"],
  ["a single dot component", "npm/./x"],
  ["a percent-encoded dotdot", "%2e%2e%2fetc%2fpasswd"],
  ["any percent encoding at all", "npm/a%20b"],
  ["a query string", "npm/a?x=1"],
  ["a fragment", "npm/a#x"],
  ["a backslash", "npm\\..\\x"],
  ["a NUL", "npm/a\0b"],
  ["an empty path", ""],
  ["a path of only slashes", "///"],
]) {
  const got = code(() => urlFor("jsdelivr", path));
  checkThat(`urlFor refuses ${what}`, got === "EINVAL",
    `${JSON.stringify(path)} gave ${got}`);
}
// The cloud metadata endpoint, as the concrete thing SSRF reaches for.
checkThat("urlFor cannot be pointed at the cloud metadata endpoint",
  code(() => urlFor("jsdelivr", "http://169.254.169.254/latest/meta-data/")) === "EINVAL",
  "the metadata endpoint was reachable");
checkThat("and cannot be pointed at a localhost admin port",
  code(() => urlFor("jsdelivr", "http://127.0.0.1:8000/admin")) === "EINVAL",
  "localhost was reachable");
// An unknown provider is ENODEV, and a template cannot be supplied in place of an id.
check("an unknown provider id is ENODEV", code(() => urlFor("nope", "a")), "ENODEV");
check("a URL in place of a provider id is ENODEV",
  code(() => urlFor("https://evil.example/{path}", "a")), "ENODEV");
check("a prototype key is not a provider", code(() => urlFor("constructor", "a")), "ENODEV");
check("__proto__ is not a provider", code(() => urlFor("__proto__", "a")), "ENODEV");
// A long component is refused before it reaches the network.
check("an over-long component is EINVAL", code(() => urlFor("jsdelivr", "a".repeat(256))), "EINVAL");
checkThat("a component at NAME_MAX is allowed",
  urlFor("jsdelivr", "a".repeat(255)).endsWith("a".repeat(255)), "255 was refused");

// ---- the capability probe ---------------------------------------------------------------
const stub = (status, headers, bytes) => async () => ({
  status,
  headers: { get: (h) => headers[h] ?? headers[h.toLowerCase()] ?? null },
  arrayBuffer: async () => new Uint8Array(bytes).buffer,
});
const probe = (f, want = 64) => probeProvider("local", "x", { want, fetchImpl: f });

check("a correct ranged read passes",
  (await probe(stub(206, { "Content-Range": "bytes 0-63/1000" }, 64))).why, PROBE.OK);
// THE unpkg FAILURE: 200 with the whole object.
check("a 200 for a ranged request is range-ignored",
  (await probe(stub(200, {}, 999))).why, PROBE.NO_RANGE);
check("a 404 is a bad status", (await probe(stub(404, {}, 0))).why, PROBE.STATUS);
check("a 403 is a bad status", (await probe(stub(403, {}, 0))).why, PROBE.STATUS);
check("206 with no Content-Range is refused",
  (await probe(stub(206, {}, 64))).why, PROBE.NO_CONTENT_RANGE);
check("206 with too few bytes is refused",
  (await probe(stub(206, { "Content-Range": "bytes 0-63/1000" }, 10))).why, PROBE.SHORT);
check("206 with too many bytes is refused",
  (await probe(stub(206, { "Content-Range": "bytes 0-63/1000" }, 999))).why, PROBE.SHORT);
const thrown = await probe(async () => { throw new TypeError("Failed to fetch"); });
check("a fetch rejection is unreachable, not guessed as CORS", thrown.why, PROBE.UNREACHABLE);
checkThat("and carries the message", thrown.detail.includes("Failed to fetch"), thrown);
const short = await probe(stub(206, { "Content-Range": "bytes 0-63/1000" }, 10));
checkThat("a wrong byte count reports both numbers",
  short.got === 10 && short.want === 64, short);
checkThat("every refusal names which capability was missing",
  new Set([PROBE.NO_RANGE, PROBE.STATUS, PROBE.NO_CONTENT_RANGE, PROBE.SHORT, PROBE.UNREACHABLE])
    .size === 5, "two refusals share a reason");

// ---- readRange: a broken provider is never silently repaired ---------------------------
const got = await readRange("local", "x", 0, 4, {
  fetchImpl: stub(206, { "Content-Range": "bytes 0-3/9" }, [1, 2, 3, 4]),
});
check("a ranged read returns its bytes", [...got], [1, 2, 3, 4]);
let why = "";
try {
  await readRange("local", "x", 0, 4, { fetchImpl: stub(200, {}, [1, 2, 3, 4, 5, 6, 7, 8, 9]) });
} catch (e) { why = e.code + ":" + e.message; }
checkThat("a provider that ignored Range is EIO, not trimmed to look correct",
  why.startsWith("EIO") && why.includes("ignored Range"), why);
const big = PROVIDERS.local.maxObject;
let fbig = "";
try {
  await readRange("local", "x", 0, big + 1, { fetchImpl: stub(206, {}, []) });
} catch (e) { fbig = e.code; }
check("a read past the provider's maximum is EFBIG, before the request", fbig, "EFBIG");
let fneg = "";
try { await readRange("local", "x", -1, 4, { fetchImpl: stub(206, {}, []) }); } catch (e) { fneg = e.code; }
check("a negative offset is EINVAL", fneg, "EINVAL");
let fzero = "";
try { await readRange("local", "x", 0, 0, { fetchImpl: stub(206, {}, []) }); } catch (e) { fzero = e.code; }
check("a zero length is EINVAL", fzero, "EINVAL");

const failed = results.filter((r) => !r.ok);
console.log(JSON.stringify({
  ok: failed.length === 0, total: results.length, failed: failed.length, failures: failed,
}, null, 2));
process.exit(failed.length ? 1 : 0);
