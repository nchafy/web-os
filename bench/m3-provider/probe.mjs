// The provider table under Node, with a stub fetch. No network.
//
// THE SUBJECT IS THE SSRF REFUSAL. `urlFor` is the only place a request URL is built, so every way
// a path could escape the committed template's origin is tested here by asserting the refusal
// CODE, not just that something threw.
import {
  PROVIDERS, REMOTE_PROVIDERS, REJECTED_PROVIDERS, urlFor, probeProvider, readRange, PROBE,
} from "../../src/kernel/providers.mjs";
import { mountProvider, USR_ENTRIES } from "../../src/kernel/providerfs.mjs";
import { DIR, FILE } from "../../src/fs/vfs.mjs";

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


// ---- /usr mounted on a provider ---------------------------------------------------------
// THE SUBJECT IS THE MOUNT REFUSING LOUDLY. MILESTONES.md M3's second negative control: point a
// provider at a 404 and the mount must fail, never silently serve an empty /usr. Four ways it can
// fail -- a 404 on the probe object, a 404 on a later object, a provider that ignores Range, and
// an unreachable host -- each asserted by its own errno and message.

// A provider that serves ranged reads correctly.
const good = async (url, init) => {
  const m = /bytes=(\d+)-(\d+)/.exec(init.headers.Range);
  const want = Number(m[2]) - Number(m[1]) + 1;
  const body = new Uint8Array(Math.min(want, 500)).fill(65);
  return { status: 206, headers: { get: (h) => h === "Content-Range" ? `bytes 0-${body.length-1}/500` : null },
           arrayBuffer: async () => body.buffer };
};
const { fs, report } = await mountProvider({ id: "local", fetchImpl: good });
check("the mount reports its provider", report.provider, "local");
check("and how many entries it read", report.entries, USR_ENTRIES.length);
checkThat("and how many bytes", report.bytes > 0, report.bytes);
check("the mount root is a directory", fs.stat({}, "/").type, DIR);
check("implied directories exist", fs.listRel("/").map(e=>e.name).sort(), ["include","lib"]);
check("lib lists its files", fs.listRel("/lib").map(e=>e.name).sort(), ["process.mjs","syscall.mjs"]);
check("a file is a file", fs.stat({}, "/lib/syscall.mjs").type, FILE);
checkThat("a file has bytes", fs.bytesAt("/lib/syscall.mjs").length > 0, "empty");
check("mode is r-xr-xr-x", fs.stat({}, "/lib/syscall.mjs").mode, 0o555);
check("/usr refuses a write with EROFS", code(() => fs.unlink({}, "/lib/syscall.mjs")), "EROFS");
check("an absent file is ENOENT", code(() => fs.stat({}, "/lib/nope.mjs")), "ENOENT");

// THE CONTROL: a 404 on one object must refuse the WHOLE mount, not serve an empty /usr.
const probeOk404 = async (url, init) => {
  if (url.includes("syscall.mjs")) {
    const body = new Uint8Array(64).fill(65);
    return { status: 206, headers: { get: () => "bytes 0-63/500" }, arrayBuffer: async () => body.buffer };
  }
  return { status: 404, headers: { get: () => null }, arrayBuffer: async () => new ArrayBuffer(0) };
};
let threw = "";
try { await mountProvider({ id: "local", fetchImpl: probeOk404 }); }
catch (e) { threw = `${e.code}:${e.message}`; }
checkThat("a 404 on a manifest object refuses the mount", threw.startsWith("EIO"), threw || "NO THROW");
checkThat("and names the object that failed", threw.includes("process.mjs"), threw);

// A 404 on the probe object itself.
const all404 = async () => ({ status: 404, headers: { get: () => null }, arrayBuffer: async () => new ArrayBuffer(0) });
let t2 = "";
try { await mountProvider({ id: "local", fetchImpl: all404 }); } catch (e) { t2 = `${e.code}:${e.message}`; }
checkThat("a 404 on the probe refuses the mount", t2.startsWith("ENODEV"), t2 || "NO THROW");
checkThat("and says the probe failed", t2.includes("capability probe"), t2);

// A provider that ignores Range (the unpkg failure) must refuse the mount, not degrade it.
const ignoresRange = async () => ({ status: 200, headers: { get: () => null },
  arrayBuffer: async () => new Uint8Array(999).buffer });
let t3 = "";
try { await mountProvider({ id: "local", fetchImpl: ignoresRange }); } catch (e) { t3 = `${e.code}:${e.message}`; }
checkThat("a provider ignoring Range refuses the mount", t3.startsWith("ENODEV"), t3 || "NO THROW");
checkThat("and names range-ignored", t3.includes("range-ignored"), t3);

// An unreachable provider.
const dead = async () => { throw new TypeError("Failed to fetch"); };
let t4 = "";
try { await mountProvider({ id: "local", fetchImpl: dead }); } catch (e) { t4 = `${e.code}:${e.message}`; }
checkThat("an unreachable provider refuses the mount with EIO", t4.startsWith("EIO"), t4 || "NO THROW");

// An unknown provider, and an empty manifest.
let t5 = ""; try { await mountProvider({ id: "nope", fetchImpl: good }); } catch (e) { t5 = e.code; }
check("an unknown provider is ENODEV", t5, "ENODEV");
let t6 = ""; try { await mountProvider({ id: "local", entries: [], fetchImpl: good }); } catch (e) { t6 = e.code; }
check("an empty manifest is EINVAL", t6, "EINVAL");

const failed = results.filter((r) => !r.ok);
console.log(JSON.stringify({
  ok: failed.length === 0, total: results.length, failed: failed.length, failures: failed,
}, null, 2));
process.exit(failed.length ? 1 : 0);
