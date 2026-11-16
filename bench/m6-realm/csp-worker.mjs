// What a dedicated MODULE worker can reach, and which Content-Security-Policy delivery bounds
// its module loader. Stands in for a process worker: same origin, same type, no kernel, so the
// loop is one page load rather than a kernel boot.
//
// Every row is a CALL, not a `typeof`. `typeof fetch` says the binding is there; it does not say
// the call reaches the network, and after M6's lockdown the two answers differ by design.

import { DEP } from "./csp-dep.mjs";

/** CSP violations observed in THIS realm, in order. The refusal's own name: an import that fails
 *  for a CSP reason and one that fails because nothing is listening are different facts, and the
 *  thrown error does not distinguish them. */
const violations = [];
self.addEventListener("securitypolicyviolation", (e) => {
  violations.push({
    blockedURI: String(e.blockedURI || "").slice(0, 120),
    directive: String(e.effectiveDirective || e.violatedDirective || ""),
    policy: String(e.originalPolicy || "").slice(0, 200),
  });
});

const ok = (value) => ({ ok: true, value: String(value).slice(0, 120) });
const no = (error) => ({
  ok: false,
  why: String((error && (error.name ? `${error.name}: ${error.message}` : error.message)) || error)
    .slice(0, 200),
});

async function attempt(fn) {
  try {
    return ok(await fn());
  } catch (error) {
    return no(error);
  }
}

/** The ambient filesystem. The headline of constraint 41: a same-origin worker holds OPFS with no
 *  credential, so this writes a file the kernel never heard of and reads it back. */
async function opfs() {
  const root = await navigator.storage.getDirectory();
  const fh = await root.getFileHandle("m6-csp-probe", { create: true });
  const handle = await fh.createSyncAccessHandle();
  try {
    const bytes = new TextEncoder().encode("ambient");
    handle.truncate(0);
    handle.write(bytes, { at: 0 });
    handle.flush();
    const back = new Uint8Array(handle.getSize());
    handle.read(back, { at: 0 });
    const names = [];
    for await (const name of root.keys()) {
      names.push(name);
      if (names.length >= 8) break;
    }
    return `wrote ${new TextDecoder().decode(back)}; root holds ${names.join(",")}`;
  } finally {
    handle.close();
    await root.removeEntry("m6-csp-probe").catch(() => {});
  }
}

/** A nested worker. Constraint 53: invisible to the process table while holding a renderer slot. */
function nested() {
  return new Promise((resolve, reject) => {
    let url = "";
    try {
      url = URL.createObjectURL(new Blob(["self.postMessage('nested alive')"],
        { type: "text/javascript" }));
    } catch (error) {
      reject(error);
      return;
    }
    const w = new Worker(url);
    const timer = setTimeout(() => { w.terminate(); reject(new Error("nested worker silent")); },
      3000);
    w.onmessage = (e) => { clearTimeout(timer); w.terminate(); resolve(String(e.data)); };
    w.onerror = (e) => { clearTimeout(timer); w.terminate(); reject(new Error(e.message || "nested onerror")); };
  });
}

/**
 * The hole no scanner can close: a dynamic import whose specifier is COMPUTED.
 *
 * `"da" + "ta:..."` is not a literal the kernel's linker can see, and the module loader is not
 * `fetch`, so deleting `fetch` does not touch it. Three schemes, because each is closed by a
 * different half of M6: `data:` and off-origin `http:` by the policy, `blob:` by the realm
 * lockdown taking `URL.createObjectURL` away.
 */
async function imports(remoteBase) {
  const out = {};
  const dataUrl = "da" + "ta:text/javascript,export const V = 'data: evaluated'";
  out.data = await attempt(async () => (await import(dataUrl)).V);
  out.blob = await attempt(async () => {
    const url = URL.createObjectURL(
      new Blob(["export const V = 'blob: evaluated'"], { type: "text/javascript" }));
    try {
      return (await import(url)).V;
    } finally {
      URL.revokeObjectURL(url);
    }
  });
  // COMPUTED, so the kernel's linker could not have seen it even as a literal. The hostile
  // server's root IS bench/m6-realm, so the path is bare.
  out.remote = remoteBase
    ? await attempt(async () => (await import(remoteBase + "/remote.mjs")).V)
    : { ok: false, why: "no hostile origin was given, so this row was not measured" };
  out.sameOrigin = await attempt(async () => (await import("/src/abi.mjs")).ABI_FINGERPRINT);
  return out;
}

/**
 * THE LOAD-BEARING ROW: the same two imports attempted from INSIDE a blob module.
 *
 * A program is not the worker's own script — it is a Blob URL the kernel mints and the libos
 * imports (src/kernel/exec.mjs). If a policy delivered on the worker script did not reach a
 * module imported from `blob:`, the whole design would be bounded in the one realm no program
 * runs in. CSP is per-realm and a blob module shares the worker's realm, so it should hold; this
 * row is the measurement rather than the inference.
 */
async function insideBlob(remoteBase) {
  const body = `
    const out = {}
    const attempt = async (fn) => {
      try { return { ok: true, value: String(await fn()).slice(0, 80) } }
      catch (e) { return { ok: false, why: String((e && e.message) || e).slice(0, 120) } }
    }
    out.data = await attempt(async () =>
      (await import("da" + "ta:text/javascript,export const V = 'data: from inside a program'")).V)
    out.remote = ${JSON.stringify(String(remoteBase || ""))}
      ? await attempt(async () => (await import(${JSON.stringify(String(remoteBase || ""))} + "/remote.mjs")).V)
      : { ok: false, why: "no hostile origin given" }
    out.evalInProgram = await attempt(() => (0, eval)("1 + 1"))
    export const RESULT = out
  `;
  let url = "";
  try {
    url = URL.createObjectURL(new Blob([body], { type: "text/javascript" }));
  } catch (error) {
    return { ok: false, why: `could not mint the program image: ${(error && error.message) || error}` };
  }
  try {
    const mod = await import(url);
    return { ok: true, value: JSON.stringify(await mod.RESULT) };
  } catch (error) {
    return no(error);
  } finally {
    URL.revokeObjectURL(url);
  }
}

self.onmessage = async (ev) => {
  const { remoteBase } = ev.data || {};
  const rows = {};
  rows.dep = ok(DEP);
  rows.isolated = ok(self.crossOriginIsolated === true);
  rows.storage = await attempt(opfs);
  rows.fetch = await attempt(async () => {
    const r = await fetch("/bench/m6-realm/csp-dep.mjs");
    return `${r.status} ${(await r.text()).length} bytes`;
  });
  rows.xhr = await attempt(() => {
    const x = new XMLHttpRequest();
    x.open("GET", "/bench/m6-realm/csp-dep.mjs", false);
    x.send();
    return `${x.status} ${String(x.responseText).length} bytes`;
  });
  rows.importScripts = await attempt(() => {
    self.importScripts("/bench/m6-realm/csp-classic.js");
    return `importScripts ran: ${self.__m6_classic}`;
  });
  rows.indexedDB = await attempt(() => new Promise((resolve, reject) => {
    const req = indexedDB.open("m6-csp-probe", 1);
    req.onsuccess = () => { req.result.close(); indexedDB.deleteDatabase("m6-csp-probe"); resolve("opened"); };
    req.onerror = () => reject(req.error || new Error("indexedDB refused"));
    req.onblocked = () => reject(new Error("indexedDB blocked"));
  }));
  rows.caches = await attempt(async () => {
    const c = await caches.open("m6-csp-probe");
    await caches.delete("m6-csp-probe");
    return c ? "opened" : "no cache";
  });
  rows.webSocket = await attempt(() => {
    const s = new WebSocket("ws://127.0.0.1:1/");
    s.close();
    return "constructed";
  });
  rows.sharedWorker = await attempt(() => {
    const s = new SharedWorker("/bench/m6-realm/csp-shared.mjs", { type: "module" });
    s.port.close();
    return "constructed";
  });
  rows.createObjectURL = await attempt(() => {
    const u = URL.createObjectURL(new Blob(["x"]));
    URL.revokeObjectURL(u);
    return u.slice(0, 40);
  });
  rows.nestedWorker = await attempt(nested);
  // `eval` and `new Function` are a second route to evaluating text the kernel never saw, and
  // `script-src` without `'unsafe-eval'` is what refuses them. Measured rather than assumed,
  // because a shell that needed `eval` would make the policy unshippable.
  rows.eval = await attempt(() => (0, eval)("1 + 1"));
  rows.newFunction = await attempt(() => new Function("return 2 + 2")());
  rows.imports = await imports(String(remoteBase || ""));
  rows.insideBlob = await insideBlob(String(remoteBase || ""));
  self.postMessage({ rows, violations });
};
