// M6's process program: the bypass, attempted for real against the kernel's own volume.
//
// MILESTONES.md M6's proof is "a program containing the bypass snippet fails, and /proc shows it
// faulted", and its control is "skip the stripping; the same program must succeed". Four modes,
// each spawned BY THE PAGE so the page can choose its uid — a child inherits its parent's
// credential and `SYS_spawn` carries no uid field, which is deliberate (constraint 29).
//
//   p_victim   uid 0: write a file no unprivileged process may touch. Reports its inode.
//   p_attack   uid 1000: every binding constraint 41 names, every scheme the loader takes, and
//              the headline — open the kernel's blob BY INODE through ambient OPFS and write it.
//              RETURNS its rows rather than throwing, because a faulted process has no result and
//              the detail is the point of this mode.
//   p_verify   uid 0: read the victim back THROUGH THE SYSCALL CHANNEL. Are the kernel's bytes
//              still the kernel's? Then unlink it, so a second run does not meet the first's
//              tampered file.
//   p_procfault uid 0: what /proc says about a pid that faulted — `state`, `exitkind`,
//              `exitvalue`. Run on an already-live process, because the answer expires with the
//              terminate quarantine (constraint 14).
//   p_fault    uid 1000: MILESTONES.md's own shape — the bypass snippet with no try/catch. It
//              must FAULT with the lockdown and must SUCCEED without it.
//
// WHY THE TWO ATTACKERS ARE SEPARATE MODES. A program that faults produces no result, so a single
// program could not both demonstrate the fault and report what refused it. `p_attack` carries the
// evidence; `p_fault` is the proof in MILESTONES.md's words, and it is four lines.

import {
  E, O_CREAT, O_RDONLY, O_TRUNC, O_WRONLY,
} from "/src/abi.mjs";

const ENC = new TextEncoder();
const DEC = new TextDecoder();

/** The victim's contents, and what a successful bypass replaces them with. THE SAME LENGTH, on
 *  purpose: a file's length is inode metadata the kernel holds in memory, so a longer tamper would
 *  be read back truncated and a shorter one padded — either of which would muddle "the bytes
 *  changed" with "the bytes changed by this much". */
export const VICTIM_BYTES = "KERNEL-OWNED-SECRET\n";
export const TAMPER_BYTES = "TAMPERED-BY-PROCESS\n";

/** The OPFS names the kernel's volume uses. Written here as the ATTACKER sees them — it does not
 *  import the kernel's constants, because a process cannot import kernel code; it guesses the
 *  layout, which is exactly what an attacker does, and the guess is right (constraint 26). */
const BLOB_DIR = "blobs";

/**
 * THE REFUSAL'S OWN NAME, from inside the realm that was refused.
 *
 * A thrown `TypeError: Failed to fetch dynamically imported module` reads the same whether a
 * policy refused the load or nothing was listening at the other end, so the throw cannot
 * attribute the refusal. A `securitypolicyviolation` event can: it names the blocked URI and the
 * directive that blocked it. Registered at module scope, before any attempt, because the event
 * fires on the realm and not on the call.
 */
const violations = [];
self.addEventListener("securitypolicyviolation", (e) => {
  violations.push({
    blockedURI: String(e.blockedURI || "").slice(0, 60),
    directive: String(e.effectiveDirective || e.violatedDirective || ""),
  });
});

const ok = (value) => ({ ok: true, value: String(value).slice(0, 160) });
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

/* ----------------------------------- p_victim -------------------------------------------- */

function pVictim(env, path) {
  const fd = env.fs.open(path, O_WRONLY | O_CREAT | O_TRUNC, 0o600);
  if (fd < 0) return { ok: false, why: `open(${path}) is ${env.std.errnoName(fd)}` };
  const bytes = ENC.encode(VICTIM_BYTES);
  const wrote = env.fs.write(fd, bytes);
  const synced = env.fs.fsync(fd);
  const st = env.fs.fstat(fd);
  // CLOSED BEFORE THE ATTACKER RUNS, and that is not tidiness. OPFS gives one exclusive sync
  // access handle per file (src/kernel/iocore.mjs): with the kernel still holding it, the
  // attacker's `createSyncAccessHandle` would throw NoModificationAllowedError and the control
  // would report a refusal the lockdown had nothing to do with.
  const closed = env.fs.close(fd);
  return {
    ok: wrote === bytes.length && synced === 0 && closed === 0 && typeof st === "object",
    path,
    wrote,
    synced,
    closed,
    ino: st && typeof st === "object" ? Number(st.ino) : -1,
    mode: st && typeof st === "object" ? (st.mode & 0o7777) : -1,
    size: st && typeof st === "object" ? Number(st.size) : -1,
    why: wrote === bytes.length ? "" : `write answered ${env.std.errnoName(wrote)}`,
  };
}

/* ----------------------------------- p_attack -------------------------------------------- */

/**
 * THE HEADLINE BYPASS: the kernel's volume, by inode, with no credential and no syscall.
 *
 * The blob directory is flat and named `<ino>.<gen>` (constraint 26), and the generation is not in
 * any stat record — so the attacker ENUMERATES the directory and matches on the inode it already
 * learned from `stat`. That enumeration is itself part of the finding: a process could list every
 * blob in the system without naming one.
 */
async function tamperByInode(ino) {
  const root = await navigator.storage.getDirectory();
  const blobs = await root.getDirectoryHandle(BLOB_DIR, { create: false });
  const names = [];
  for await (const name of blobs.keys()) names.push(name);
  const mine = names.filter((n) => n.startsWith(`${ino}.`));
  if (!mine.length) {
    throw new Error(`no blob for inode ${ino}; the directory holds ${names.slice(0, 12).join(",")}`);
  }
  const fh = await blobs.getFileHandle(mine[0], { create: false });
  const handle = await fh.createSyncAccessHandle();
  try {
    const before = new Uint8Array(handle.getSize());
    handle.read(before, { at: 0 });
    handle.write(ENC.encode(TAMPER_BYTES), { at: 0 });
    handle.flush();
    return `${mine[0]}: ${JSON.stringify(DEC.decode(before))} -> ${JSON.stringify(TAMPER_BYTES)}`
      + ` (the directory holds ${names.length} blobs, all of them readable)`;
  } finally {
    handle.close();
  }
}

/** A nested worker: a process the process table cannot see (constraint 53). */
function nestedWorker() {
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
    w.onerror = () => { clearTimeout(timer); w.terminate(); reject(new Error("nested worker onerror")); };
  });
}

async function pAttack(env, path, ino) {
  const rows = {};

  // THE CREDENTIAL FIRST, as the baseline every other row is read against. This process is uid
  // 1000 and the file is 0600 root-owned, so the syscall channel MUST refuse it — and if it did
  // not, every row below would be measuring a system with no permissions rather than a realm with
  // a hole in it.
  const fd = env.fs.open(path, O_WRONLY);
  rows.syscallRefused = fd === -E.EACCES
    ? ok(`open(${path}) is EACCES, as a uid-1000 process must be told`)
    : { ok: false, why: `open(${path}) answered ${env.std.errnoName(fd)}, want EACCES` };
  if (fd >= 0) env.fs.close(fd);

  rows.storage = await attempt(async () => {
    const root = await navigator.storage.getDirectory();
    const names = [];
    for await (const name of root.keys()) names.push(name);
    return `the volume's root holds ${names.slice(0, 10).join(",")}`;
  });
  rows.tamper = await attempt(() => tamperByInode(ino));
  rows.fetch = await attempt(async () => `${(await fetch("/src/abi.mjs")).status}`);
  rows.xhr = await attempt(() => {
    const x = new XMLHttpRequest();
    x.open("GET", "/src/abi.mjs", false);
    x.send();
    return `${x.status}`;
  });
  rows.importScripts = await attempt(() => {
    self.importScripts("/bench/m6-realm/csp-classic.js");
    return "importScripts ran";
  });
  rows.indexedDB = await attempt(() => new Promise((resolve, reject) => {
    const req = indexedDB.open("m6-attack", 1);
    req.onsuccess = () => { req.result.close(); resolve("opened"); };
    req.onerror = () => reject(req.error || new Error("refused"));
  }));
  rows.caches = await attempt(async () => ((await caches.open("m6-attack")) ? "opened" : "none"));
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
  rows.createObjectURL = await attempt(() => URL.createObjectURL(new Blob(["x"])).slice(0, 40));
  rows.nestedWorker = await attempt(nestedWorker);

  // The loader's half. Each specifier is COMPUTED, so the kernel's linker could not have seen it
  // even as a literal (constraint 139) — and `import` is not `fetch`, so the strip above does not
  // touch these. The policy does.
  rows.importData = await attempt(async () =>
    (await import("da" + "ta:text/javascript,export const V = 'data: evaluated in a process'")).V);
  rows.importBlob = await attempt(async () => {
    const url = URL.createObjectURL(
      new Blob(["export const V = 'blob: evaluated in a process'"], { type: "text/javascript" }));
    return (await import(url)).V;
  });
  rows.eval = await attempt(() => (0, eval)("1 + 1"));
  rows.newFunction = await attempt(() => new Function("return 2 + 2")());

  /**
   * THE POSITIVE CONTROL, and the reason "everything refused" cannot pass for a working lockdown.
   *
   * COMPUTED FROM `self.location`, which is the WORKER's URL — `/src/libos/process.mjs` — and not
   * the program's own blob. A bare `import("/src/abi.mjs")` does not work here and that is not the
   * policy: a blob module has an opaque path, so a root-relative specifier has no base to resolve
   * against (constraint 125) and the loader answers "Failed to resolve module specifier" before
   * any policy is consulted. The static form at the top of this file is rewritten by the kernel's
   * linker; a dynamic one is not.
   *
   * It is therefore also the honest statement of what the policy still permits: `'self'` means a
   * program can dynamically import ANY same-origin module. That is residual exposure, recorded as
   * such, and it is bounded by what the server serves rather than by what the kernel allows.
   */
  rows.allowedImport = await attempt(async () =>
    `${(await import(`${self.location.origin}/src/abi.mjs`)).ABI_FINGERPRINT}`);
  rows.syscallsStillWork = (() => {
    const st = env.fs.stat("/");
    return typeof st === "object"
      ? ok(`stat(/) answered mode ${(st.mode & 0o7777).toString(8)}`)
      : { ok: false, why: `stat(/) is ${env.std.errnoName(st)}` };
  })();

  const reached = Object.entries(rows)
    .filter(([name, r]) => r.ok && !["syscallRefused", "allowedImport", "syscallsStillWork"].includes(name))
    .map(([name]) => name);
  return { ok: true, rows, reached, realmKeys: realmShape(), violations: violations.slice(0, 12) };
}

/** What the realm still exposes, by name, for a check that wants to assert absence rather than
 *  read a thrown message. `in` walks the prototype chain, which is the question a call asks. */
function realmShape() {
  const present = {};
  for (const name of ["fetch", "XMLHttpRequest", "importScripts", "indexedDB", "caches",
    "WebSocket", "Worker", "SharedWorker"]) {
    present[name] = name in self;
  }
  present["navigator.storage"] = typeof navigator === "object" && navigator !== null
    && "storage" in navigator;
  present["URL.createObjectURL"] = "createObjectURL" in URL;
  present["URL.revokeObjectURL"] = "revokeObjectURL" in URL;
  return present;
}

/* ----------------------------------- p_verify -------------------------------------------- */

function pVerify(env, path, attackerPid) {
  const fd = env.fs.open(path, O_RDONLY);
  if (fd < 0) return { ok: false, why: `open(${path}) is ${env.std.errnoName(fd)}` };
  const got = env.std.slurpText(env, fd);
  env.fs.close(fd);
  // Removed, so a second run of this check does not meet the previous run's tampered file. The
  // unlink takes the blob with it, which is what makes the control repeatable.
  const unlinked = env.fs.unlink(path);
  return {
    ok: true,
    intact: got === VICTIM_BYTES,
    got: String(got).slice(0, 80),
    want: VICTIM_BYTES,
    tampered: got === TAMPER_BYTES,
    attackerPid,
    unlinked,
  };
}

/* ----------------------------------- p_procfault ----------------------------------------- */

/**
 * WHAT `/proc` SAYS ABOUT THE FAULTED PROCESS. MILESTONES.md M6 asks for "/proc shows it
 * faulted", and this is the form /proc can actually express it in.
 *
 * NOT "the directory is gone", and the first version of this check asserted exactly that and was
 * wrong: a reaped process is a ZOMBIE for the ~2 s terminate quarantine (constraint 14), so /proc
 * both can and should still show it — with `state: zombie` and the kind and value it died of. A
 * clause asserting absence would have been racing the quarantine and calling the kernel's correct
 * behaviour a failure.
 *
 * Separate from `p_verify` because that mode UNLINKS the victim, so calling it twice would answer
 * "the victim is missing" for a question about a process.
 */
function pProcFault(env, pid) {
  const text = env.std.readFileText(env, `/proc/${pid}/status`);
  if (typeof text !== "string") {
    /**
     * ENOENT IS NOT A FAILED PROOF, IT IS AN UNTAKEN MEASUREMENT, and the two must not be
     * reported as one thing. A reaped process leaves the table when the ~2.2 s quarantine expires
     * (constraint 14), so a read that arrives late finds nothing — which says nothing at all
     * about whether the process faulted. `expired` is what the page turns into an unmeasurable
     * check rather than a red one; any other errno is a real failure and keeps `ok: false`.
     */
    const errno = env.std.errnoName(text);
    return {
      ok: false,
      pid,
      expired: errno === "ENOENT",
      why: `/proc/${pid}/status is ${errno}`
        + (errno === "ENOENT"
          ? " — the pid had already left the table, so the fault could not be read. The "
            + "terminate quarantine is ~2.2 s and this read has to land inside it."
          : ""),
    };
  }
  const field = (name) => {
    const m = new RegExp(`^${name}:\\t(.*)$`, "m").exec(text);
    return m ? m[1] : "";
  };
  return {
    ok: true,
    pid,
    state: field("state"),
    exitKind: Number(field("exitkind")),
    exitValue: Number(field("exitvalue")),
    // SIGABRT is what the kernel reaps a faulted process with (src/kernel/kernel.mjs, constraint
    // 140), and STAT_KILLED is 1. Both named in the row so the check asserts the SIGNAL and not
    // merely that something non-zero happened.
    wantKind: 1,
    wantValue: 6,
    status: text.slice(0, 400),
  };
}

/* ----------------------------------- p_fault --------------------------------------------- */

/**
 * MILESTONES.md M6's proof, in its own words: "a program containing the bypass snippet".
 *
 * NO try/catch, DELIBERATELY. With the realm stripped, `navigator.storage` is not there and this
 * throws a TypeError the libos reports as this process's fault (constraint 140), so the process
 * dies and `/proc` loses it. Without the strip it RESOLVES, the program returns a result, and
 * nothing faults — which is the control, and the reason this mode holds nothing else: anything
 * else in here would be a second reason the row could move.
 */
async function pFault(env) {
  const root = await navigator.storage.getDirectory();
  const names = [];
  for await (const name of root.keys()) names.push(name);
  return { ok: true, bypassed: true, names: names.slice(0, 8) };
}

/* ----------------------------------- entry ----------------------------------------------- */

export async function run(env, go) {
  const argv = (env.argv && env.argv.length ? env.argv : (go && go.argv) || []);
  const mode = String(argv[0] || "noop");
  const path = String(argv[1] || "/m6-victim");
  const t0 = performance.now();
  let out;
  try {
    switch (mode) {
      case "p_victim": out = pVictim(env, path); break;
      case "p_attack": out = await pAttack(env, path, Number(argv[2] || -1)); break;
      case "p_verify": out = pVerify(env, path, Number(argv[2] || -1)); break;
      case "p_procfault": out = pProcFault(env, Number(argv[2] || -1)); break;
      case "p_fault": out = await pFault(env); break;
      default: out = { ok: false, why: `unknown mode ${mode}` };
    }
  } catch (error) {
    // p_fault is the one mode that MUST NOT be caught here: its throw is the proof. Every other
    // mode reports its own failure, because a fault carries no result and the page would wait out
    // its timeout for one that can never come.
    if (mode === "p_fault") throw error;
    out = { ok: false, why: `${mode} threw: ${(error && error.stack) || error}` };
  }
  return { mode, ms: performance.now() - t0, ...out };
}
