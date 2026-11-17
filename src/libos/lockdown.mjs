// M6. The realm a program is evaluated in, with everything that is not the syscall channel taken
// out of it. Constraints 41 and 53.
//
// IT IS HARDENING, NOT A SECURITY BOUNDARY. A reference that was never handed out cannot be
// recovered, but nothing here stops the FIRST-party author of a program from doing anything the
// page itself can do. The threat model for v1 is first-party only. Say that wherever this is
// described.
//
// The strip does not cover `import(expr)`: a computed specifier is the module loader, not `fetch`,
// and no scanner over the program text can catch it (constraint 139). That half is a
// Content-Security-Policy on the process realm's worker script (`scripts/serve.py`). The two
// halves are disjoint and neither is sufficient alone.

/** What a process realm loses, as data, so a check can enumerate it instead of restating it. `on`
 *  is the object the property is reached THROUGH, not the one it is defined on, so the removal
 *  walks the prototype chain. */
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

/** `on` -> the object to walk. An unknown `on` throws; a silent skip would report a live binding
 *  as removed. */
function container(scope, on) {
  if (on === "global") return scope;
  if (on === "navigator") return scope.navigator;
  if (on === "URL") return scope.URL;
  throw new Error(`lockdown: no container named ${JSON.stringify(on)}`);
}

/** Delete one property wherever the prototype chain defines it. `delete obj.name` removes only an
 *  OWN property, and almost nothing here is one, so a single `delete` returns true — "nothing of
 *  mine to remove" — and leaves the binding working. */
function removeDeep(target, name) {
  const where = [];
  for (let obj = target; obj !== null && obj !== undefined; obj = Object.getPrototypeOf(obj)) {
    if (!Object.prototype.hasOwnProperty.call(obj, name)) continue;
    const label = (obj.constructor && obj.constructor.name) || "object";
    try {
      if (delete obj[name]) where.push(label);
    } catch (error) {
      // A non-configurable property, in strict mode: `where` logs attempts, not successes.
      where.push(`${label}: ${(error && error.message) || error}`);
    }
  }
  return where;
}

/**
 * Strip the realm. Returns a report; THROWS if anything it was asked to remove is still callable.
 * IT FAILS CLOSED AND SAYS WHY — a quiet failure leaves a process with ambient storage and a green
 * check. The caller runs it BEFORE it evaluates program text (src/libos/process.mjs).
 *
 * @param {object} [scope] the global to strip. A parameter so a host test can hand it a double.
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
    // The verification, not `delete`'s return: `in` walks the chain, as a program's call does.
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
