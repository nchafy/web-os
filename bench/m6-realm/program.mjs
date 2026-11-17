// M6's process program: the bypass, attempted for real against the kernel's own volume.
//
// MILESTONES.md M6's proof is "a program containing the bypass snippet fails, and /proc shows it
// faulted", and its control is "skip the stripping; the same program must succeed". Each mode is
// spawned by the page so the page can choose its uid — a child inherits its parent's credential
// and `SYS_spawn` carries no uid field (constraint 29).
//
//   p_victim   uid 0: write a file no unprivileged process may touch. Reports its inode.
//   p_attack   uid 1000: every binding constraint 41 names, every scheme the loader takes, and
//              the headline — open the kernel's blob by inode through ambient OPFS and write it.
//              Returns its rows rather than throwing: a faulted process has no result, and the
//              detail is the point of this mode.
//   p_verify   uid 0: read the victim back through the syscall channel, then unlink it so a second
//              run does not meet the first's tampered file.
//   p_procfault uid 0: what /proc says about a pid that faulted — `state`, `exitkind`,
//              `exitvalue`. Run on an already-live process, because the answer expires with the
//              terminate quarantine (constraint 14).
//   p_show     the realm printed to stdout, for a person at a shell.
//   p_fault    uid 1000: MILESTONES.md's own shape — the bypass snippet with no try/catch. It
//              must fault with the lockdown and must succeed without it.

import {
  E, O_CREAT, O_RDONLY, O_TRUNC, O_WRONLY,
} from "/src/abi.mjs";

const ENC = new TextEncoder();
const DEC = new TextDecoder();

/** The victim's contents, and what a successful bypass replaces them with. The same length on
 *  purpose: a file's length is inode metadata the kernel holds in memory, so a longer tamper reads
 *  back truncated and a shorter one padded, muddling "the bytes changed" with "by how much". */
export const VICTIM_BYTES = "KERNEL-OWNED-SECRET\n";
export const TAMPER_BYTES = "TAMPERED-BY-PROCESS\n";

/** The OPFS names the kernel's volume uses, as the attacker sees them: a process cannot import
 *  kernel code, so it guesses the layout, and the guess is right (constraint 26). */
const BLOB_DIR = "blobs";

/**
 * A `data:` module, as a specifier no scanner can see. The kernel's linker extracts every string
 * literal that follows `import(` and compares it to its allowlist (constraint 139), so a
 * half-computed specifier is seen and the file refused with ENOEXEC. Assembling the URL away from
 * the call site makes it genuinely invisible, which is what the policy has to stop — and with the
 * literal gone this program loads through the filesystem, so the shell can spawn it too.
 */
const DATA_MODULE = ["da", "ta:text/javascript,export const V = 'data: evaluated in a process'"]
  .join("");

/**
 * A thrown `TypeError: Failed to fetch dynamically imported module` reads the same whether a policy
 * refused the load or nothing was listening, so the throw cannot attribute the refusal. A
 * `securitypolicyviolation` event names the blocked URI and the directive. Registered at module
 * scope, before any attempt, because the event fires on the realm and not on the call.
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

function pVictim(env, path) {
  const fd = env.fs.open(path, O_WRONLY | O_CREAT | O_TRUNC, 0o600);
  if (fd < 0) return { ok: false, why: `open(${path}) is ${env.std.errnoName(fd)}` };
  const bytes = ENC.encode(VICTIM_BYTES);
  const wrote = env.fs.write(fd, bytes);
  const synced = env.fs.fsync(fd);
  const st = env.fs.fstat(fd);
  // Closed before the attacker runs. OPFS gives one exclusive sync access handle per file
  // (src/kernel/iocore.mjs): with the kernel still holding it, the attacker's
  // `createSyncAccessHandle` throws NoModificationAllowedError and the control reports a refusal
  // the lockdown had nothing to do with.
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

/**
 * The headline bypass: the kernel's volume, by inode, with no credential and no syscall. The blob
 * directory is flat and named `<ino>.<gen>` (constraint 26) and the generation is in no stat
 * record, so the attacker enumerates the directory and matches on the inode it learned from
 * `stat`. That enumeration is part of the finding: a process can list every blob without naming
 * one.
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

  // The baseline every other row is read against. This process is uid 1000 and the file is 0600
  // root-owned, so the syscall channel must refuse it; if it did not, every row below would be
  // measuring a system with no permissions rather than a realm with a hole in it.
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

  // The loader's half. Each specifier is computed, so the kernel's linker cannot have seen it as a
  // literal (constraint 139), and `import` is not `fetch`, so the strip does not touch these. The
  // policy does.
  rows.importData = await attempt(async () =>
    (await import(DATA_MODULE)).V);
  rows.importBlob = await attempt(async () => {
    const url = URL.createObjectURL(
      new Blob(["export const V = 'blob: evaluated in a process'"], { type: "text/javascript" }));
    return (await import(url)).V;
  });
  rows.eval = await attempt(() => (0, eval)("1 + 1"));
  rows.newFunction = await attempt(() => new Function("return 2 + 2")());

  /**
   * The positive control: "everything refused" cannot pass for a working lockdown. Computed from
   * `self.location`, the worker's URL, not the program's own blob — a bare `import("/src/abi.mjs")`
   * fails for a reason that is not the policy, because a blob module has an opaque path, so a
   * root-relative specifier has no base to resolve against (constraint 125) and the loader answers
   * "Failed to resolve module specifier" first. The row is also what the policy still permits:
   * `'self'` lets a program dynamically import any same-origin module, residual exposure bounded
   * by what the server serves.
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

function pVerify(env, path, attackerPid) {
  const fd = env.fs.open(path, O_RDONLY);
  if (fd < 0) return { ok: false, why: `open(${path}) is ${env.std.errnoName(fd)}` };
  const got = env.std.slurpText(env, fd);
  env.fs.close(fd);
  // The unlink takes the blob with it, which is what makes the control repeatable: a second run
  // would otherwise meet the previous run's tampered file.
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

/**
 * The realm, printed to stdout, for a person at a shell. Every other mode reports to the page;
 * this one writes a table to fd 1, so "is this shell inside M6's stripped realm?" is answered from
 * inside the realm rather than from a document that can only assert it. Takes no arguments and
 * writes nothing, so it is safe to type anywhere.
 */
async function pShow(env) {
  const rows = [];
  const add = async (name, fn) => {
    const r = await attempt(fn);
    rows.push([name, r.ok ? `REACHED  ${r.value}` : `refused  ${r.why}`]);
    return r.ok;
  };

  await add("navigator.storage", async () => {
    const root = await navigator.storage.getDirectory();
    const names = [];
    for await (const n of root.keys()) names.push(n);
    return `the kernel's own volume: ${names.join(",")}`;
  });
  await add("fetch", async () => `${(await fetch("/src/abi.mjs")).status}`);
  await add("XMLHttpRequest", () => new XMLHttpRequest() && "constructed");
  await add("indexedDB", () => indexedDB.open("m6-show") && "opened");
  await add("caches", async () => ((await caches.open("m6-show")) ? "opened" : "none"));
  await add("WebSocket", () => new WebSocket("ws://127.0.0.1:1/") && "constructed");
  await add("Worker", () => new Worker("data:,0") && "constructed");
  await add("URL.createObjectURL", () => URL.createObjectURL(new Blob(["x"])).slice(0, 32));
  await add("import(data:)", async () =>
    (await import(DATA_MODULE)).V);
  await add("eval", () => (0, eval)("1 + 1"));

  const width = rows.reduce((w, r) => Math.max(w, r[0].length), 0);
  env.std.say(env, "what this process can reach, from inside its own realm:\n");
  for (const [name, said] of rows) {
    env.std.say(env, `  ${name.padEnd(width)}  ${said.slice(0, 96)}\n`);
  }
  // The positive control, printed with the rest: a realm where everything failed looks identical
  // to a broken process. The syscall channel is the one thing that must still work.
  const st = env.fs.stat("/");
  env.std.say(env, `  ${"syscalls".padEnd(width)}  ${typeof st === "object"
    ? `REACHED  stat(/) answered mode ${(st.mode & 0o7777).toString(8)} — the channel is the way out`
    : `refused  ${env.std.errnoName(st)} — THE SYSCALL CHANNEL IS BROKEN, which is not M6`}\n`);
  const reached = rows.filter(([, said]) => said.startsWith("REACHED")).map(([n]) => n);
  env.std.say(env, reached.length
    ? `REACHED ${reached.length}: ${reached.join(", ")} — the realm is NOT stripped\n`
    : "nothing reached. The realm is stripped and the policy is in force.\n");
  return { ok: reached.length === 0, reached, exit: reached.length ? 1 : 0 };
}

/**
 * MILESTONES.md M6 asks for "/proc shows it faulted", and this is the form /proc expresses it in:
 * not absence. A reaped process is a zombie for the ~2 s terminate quarantine (constraint 14), so
 * /proc still shows it, with `state: zombie` and the kind and value it died of. A clause asserting
 * absence races the quarantine and calls the kernel's correct behaviour a failure. Separate from
 * `p_verify` because that mode unlinks the victim.
 */
function pProcFault(env, pid) {
  const text = env.std.readFileText(env, `/proc/${pid}/status`);
  if (typeof text !== "string") {
    /**
     * ENOENT is an untaken measurement, not a failed proof. A reaped process leaves the table when
     * the ~2.2 s quarantine expires (constraint 14), so a late read finds nothing and says nothing
     * about whether the process faulted. The page turns `expired` into an unmeasurable check
     * rather than a red one; any other errno is a real failure and keeps `ok: false`.
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
    // 140), and STAT_KILLED is 1. Both named in the row so the check asserts the signal and not
    // merely that something non-zero happened.
    wantKind: 1,
    wantValue: 6,
    status: text.slice(0, 400),
  };
}

/**
 * MILESTONES.md M6's proof, in its own words: "a program containing the bypass snippet". No
 * try/catch. With the realm stripped, `navigator.storage` is absent and this throws a TypeError
 * the libos reports as this process's fault (constraint 140); without the strip it resolves and
 * nothing faults, which is the control. The mode holds nothing else because anything else would
 * be a second reason the row could move.
 */
async function pFault(env) {
  const root = await navigator.storage.getDirectory();
  const names = [];
  for await (const name of root.keys()) names.push(name);
  return { ok: true, bypassed: true, names: names.slice(0, 8) };
}

export async function run(env, go) {
  const given = (env.argv && env.argv.length ? env.argv : (go && go.argv) || []);
  /**
   * Two argv shapes, because this program's two callers disagree by convention. The page spawns it
   * with `cfg.argv = [mode, …]`; a shell passes POSIX argv, where argv[0] is the program name
   * (`src/bin/true.mjs` states the contract), so reading argv[0] as the mode answers "unknown
   * mode" to a correct command line. Detected on the shape: argv[0] naming this file is a program
   * name, not a mode.
   */
  const argv = /(^\/|\.mjs$)/.test(String(given[0] || "")) ? given.slice(1) : given;
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
      case "p_show": out = await pShow(env); break;
      case "p_fault": out = await pFault(env); break;
      default: out = { ok: false, why: `unknown mode ${mode}` };
    }
  } catch (error) {
    // p_fault must not be caught here: its throw is the proof. Every other mode reports its own
    // failure, because a fault carries no result and the page would wait out its timeout for one
    // that can never come.
    if (mode === "p_fault") throw error;
    out = { ok: false, why: `${mode} threw: ${(error && error.stack) || error}` };
  }
  return { mode, ms: performance.now() - t0, ...out };
}
