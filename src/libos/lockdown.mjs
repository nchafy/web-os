// M6. The realm a program is evaluated in, with everything that is not the syscall channel taken
// out of it. Constraints 41 and 53.
//
// WHY THIS FILE EXISTS. A process worker is same-origin, so it is handed the whole platform:
// `navigator.storage.getDirectory()` opens the Origin Private File System the kernel keeps its
// volume in, and the blob directory is flat and named by inode (constraint 26), so a program can
// open the kernel's own bytes by name and write them — no credential consulted, no mode bit read,
// no syscall made. Measured in exactly that form by `bench/m6-realm/csp-probe.py`:
// `storage REACHED  wrote ambient; root holds m6-csp-probe`. Everything above this milestone —
// the per-call credential (29), the mode bits, the journal's write ordering — is decoration while
// that is true.
//
// IT IS HARDENING, NOT A SECURITY BOUNDARY, and the distinction is not a disclaimer. Same-origin
// is not a security boundary: a realm is bounded by what its references reach, and a reference
// that was never handed out cannot be recovered, but nothing here stops the FIRST-party author of
// a program from doing anything the page itself can do. The threat model for v1 is first-party
// only. Say that wherever this is described.
//
// WHAT THIS FILE CANNOT DO, and what does it instead. `import(expr)` with a computed argument is
// the module loader, not `fetch`, so deleting `fetch` leaves it untouched and no scanner over the
// program text can catch it (constraint 139). That half is a Content-Security-Policy on the
// process realm's own worker script — `scripts/serve.py`, and the measurement that decided WHERE
// the policy has to be delivered is in `bench/m6-realm/csp-probe.py`. The two halves are
// disjoint: the policy does not touch OPFS, `indexedDB`, `caches` or `URL.createObjectURL`, and
// the strip does not touch the loader. Neither is sufficient alone, which is why both ship here.

/**
 * What a process realm loses, as DATA.
 *
 * One row per binding, each naming what it reaches, so the list can be enumerated by a check
 * instead of restated in one. `on` is the object the property is reached through, not necessarily
 * the object it is defined on: `fetch` is an inherited method of the global scope and `storage` is
 * an accessor on `WorkerNavigator.prototype`, so the removal walks the prototype chain.
 */
export const TARGETS = Object.freeze([
  Object.freeze({
    on: "global", name: "fetch",
    why: "the network, and with it any byte the kernel never saw",
  }),
  Object.freeze({
    on: "global", name: "XMLHttpRequest",
    why: "the same network, synchronously, which also blocks the process worker",
  }),
  Object.freeze({
    on: "global", name: "importScripts",
    why: "arbitrary same-origin script into this realm. Absent in a module worker on Chrome 157 "
         + "and removed anyway: 'the platform happens not to expose it here' is not a boundary",
  }),
  Object.freeze({
    on: "global", name: "indexedDB",
    why: "durable storage no kernel accounts for, and a second place a program can keep state "
         + "across its own death",
  }),
  Object.freeze({
    on: "global", name: "caches",
    why: "durable storage again, plus a response store the loader will read from",
  }),
  Object.freeze({
    on: "global", name: "WebSocket",
    why: "a bidirectional network connection. The policy refuses the CONNECTION asynchronously "
         + "(measured: the constructor still returns), so only the strip makes the binding absent",
  }),
  Object.freeze({
    on: "global", name: "Worker",
    why: "a process the process table cannot see. Constraint 53 confirmed it at depth 3, holding "
         + "the kernel's SAB and able to block — so the cap in constraint 17 is enforced over a "
         + "number that is not the real one until this is gone. A correctness requirement, not "
         + "only a hardening one",
  }),
  Object.freeze({
    on: "global", name: "SharedWorker",
    why: "the same, plus a realm that outlives the process. Absent in a dedicated worker on "
         + "Chrome 157; removed anyway, for the reason importScripts is",
  }),
  Object.freeze({
    on: "navigator", name: "storage",
    why: "THE HEADLINE. Ambient OPFS: the kernel's own volume, by inode, with no credential",
  }),
  Object.freeze({
    on: "URL", name: "createObjectURL",
    why: "a `blob:` URL the program can then import. The policy MUST allow blob: — a program "
         + "image is one (src/kernel/exec.mjs) — so this is the only thing that stops a program "
         + "minting its own image and evaluating text no linker checked",
  }),
  Object.freeze({
    on: "URL", name: "revokeObjectURL",
    why: "goes with createObjectURL. Alone it is a way to break a URL this realm cannot name, "
         + "and leaving half a pair is an invitation to put the other half back",
  }),
]);

/** `on` -> the object to walk, resolved against a scope. One place, so a row cannot name a
 *  container the remover does not understand: an unknown `on` is an error, never a silent skip. */
function container(scope, on) {
  if (on === "global") return scope;
  if (on === "navigator") return scope.navigator;
  if (on === "URL") return scope.URL;
  throw new Error(`lockdown: no container named ${JSON.stringify(on)}`);
}

/**
 * Delete one property wherever the prototype chain defines it.
 *
 * `delete obj.name` only removes an OWN property, and almost nothing here is one: `fetch` lives on
 * `WorkerGlobalScope.prototype` and `storage` on `WorkerNavigator.prototype`, so the obvious
 * single `delete` returns true — the operator's answer for "there is nothing of mine to remove" —
 * and leaves the binding working. That shape is why this returns WHERE it deleted from, and why
 * the caller verifies afterwards rather than trusting the return.
 */
function removeDeep(target, name) {
  const where = [];
  for (let obj = target; obj !== null && obj !== undefined; obj = Object.getPrototypeOf(obj)) {
    if (!Object.prototype.hasOwnProperty.call(obj, name)) continue;
    const label = (obj.constructor && obj.constructor.name) || "object";
    try {
      if (delete obj[name]) where.push(label);
    } catch (error) {
      // A non-configurable property, in strict mode. RECORDED IN `where` WITH ITS MESSAGE, so a
      // reader debugging a refusal sees why this one could not be removed — `where` is therefore
      // a log of attempts and not a list of successes. What turns the failure into a refusal to
      // run the program is the caller's verification, never this entry.
      where.push(`${label}: ${(error && error.message) || error}`);
    }
  }
  return where;
}

/**
 * Strip the realm. Returns a report; THROWS if anything it was asked to remove is still callable.
 *
 * FAILING CLOSED IS THE POINT. A lockdown that could not remove something and said nothing would
 * leave a process with ambient storage and a report claiming otherwise, which is strictly worse
 * than no lockdown at all — the check would be green and the hole would be open. The caller runs
 * this BEFORE it evaluates program text, so a realm that cannot be stripped faults the process
 * instead (src/libos/process.mjs).
 *
 * Idempotent: a worker that runs a second program does not strip twice, and the second report
 * reads the same as the first because every row is then `absent`.
 *
 * @param {object} [scope] the global to strip. A parameter so a host test can hand it a double;
 *                 nothing in the system passes anything but `self`.
 * @returns {{stripped: string[], absent: string[], remaining: string[], where: object}}
 */
export function lockdown(scope = self) {
  const stripped = [];
  const absent = [];
  const remaining = [];
  const where = {};
  for (const target of TARGETS) {
    const obj = container(scope, target.on);
    const key = `${target.on}.${target.name}`;
    if (obj === null || obj === undefined) {
      // The container itself is not in this realm — `navigator` in a context that has none. The
      // binding cannot be reached, so there is nothing to remove and nothing to claim.
      absent.push(key);
      continue;
    }
    const present = target.name in obj;
    if (!present) {
      absent.push(key);
      continue;
    }
    const removedFrom = removeDeep(obj, target.name);
    if (removedFrom.length) where[key] = removedFrom;
    // THE VERIFICATION, not the return value of `delete`. `in` walks the chain, which is the same
    // question a program's call asks.
    if (target.name in obj) remaining.push(key);
    else stripped.push(key);
  }
  if (remaining.length) {
    throw new Error(
      `lockdown: ${remaining.join(", ")} survived the strip, so this realm still reaches the `
      + "system without a syscall. Refusing to evaluate program text (constraint 41)");
  }
  return { stripped, absent, remaining, where };
}
