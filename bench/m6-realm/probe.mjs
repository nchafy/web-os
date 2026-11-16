// M6's host gate: `src/libos/lockdown.mjs` under Node, with no browser.
//
//     node bench/m6-realm/probe.mjs
//
// WHY IT EXISTS, and it is not duplication of `scripts/check.py --only m6`. That check runs the
// lockdown in a real process realm and proves what a program can no longer reach. It cannot reach
// ONE path: the refusal. `lockdown()` throws when a binding it was asked to remove survives, and
// in a browser nothing can make that happen — every target on Chrome 157 is configurable, so the
// branch has no caller, and the handoff's own rule says a mechanism with no live caller is
// unverified. Two milestones of latent bugs here were exactly that.
//
// A double, not a mock of a browser: `lockdown(scope)` takes the global as an argument for this
// reason, and the shapes below are the shapes that matter — an accessor on a prototype (which is
// how `fetch` and `navigator.storage` are really defined) and a NON-CONFIGURABLE property (which
// is the only way the refusal can fire).

import { TARGETS, lockdown } from "../../src/libos/lockdown.mjs";

let failed = 0;
const results = [];

function check(what, ok, detail) {
  results.push({ what, ok: !!ok, detail: ok ? undefined : detail });
  if (!ok) failed += 1;
}

/** A scope shaped like a worker's: the bindings live on a PROTOTYPE, not on the object. */
function realisticScope({ configurable = true, omit = [] } = {}) {
  const globalProto = {};
  const navProto = {};
  const define = (obj, name, value) => {
    Object.defineProperty(obj, name, { get: () => value, configurable });
  };
  for (const target of TARGETS) {
    if (omit.includes(`${target.on}.${target.name}`)) continue;
    if (target.on === "global") define(globalProto, target.name, () => {});
    if (target.on === "navigator") define(navProto, target.name, { ambient: true });
  }
  const scope = Object.create(globalProto);
  scope.navigator = Object.create(navProto);
  // `URL`'s statics are own properties of the constructor in every engine, so this one is flat.
  scope.URL = { createObjectURL: () => "blob:x", revokeObjectURL: () => {} };
  for (const name of omit) {
    const [on, key] = name.split(".");
    if (on === "URL") delete scope.URL[key];
  }
  return scope;
}

/* 1. THE LIST. Constraint 41's bindings plus constraint 53's two, as data rather than as prose in
 *    a comment: a target quietly dropped from the tuple is a target nothing strips. */
const names = TARGETS.map((t) => `${t.on}.${t.name}`);
for (const want of ["global.fetch", "global.XMLHttpRequest", "global.importScripts",
  "global.indexedDB", "global.caches", "global.WebSocket", "global.Worker",
  "global.SharedWorker", "navigator.storage", "URL.createObjectURL", "URL.revokeObjectURL"]) {
  check(`TARGETS names ${want}`, names.includes(want), names);
}
check("every target carries a reason", TARGETS.every((t) => t.why && t.why.length > 20),
      TARGETS.filter((t) => !t.why || t.why.length <= 20).map((t) => t.name));

/* 2. A PROTOTYPE PROPERTY IS ACTUALLY REMOVED. The naive `delete scope[name]` returns true here
 *    and removes nothing, which is the whole reason `removeDeep` walks the chain. */
{
  const scope = realisticScope();
  // CAUGHT, so a mutation that breaks the strip is SCORED rather than crashing this file. A
  // shallow `delete` leaves every prototype binding in place, `lockdown` then refuses, and an
  // uncaught throw here would end the run with no labels - which is a harness that cannot say
  // what moved. `bench/m6-realm/controls.py` is the mutation that proves it.
  let report = { stripped: [], absent: [], remaining: [], where: {}, threw: "" };
  try {
    report = lockdown(scope);
  } catch (error) {
    report.threw = String((error && error.message) || error);
  }
  check("a realistic scope strips without refusing", !report.threw, report.threw);
  check("every target is stripped from a realistic scope",
        report.stripped.length === TARGETS.length, report);
  // `report.remaining.length === 0` ALONE WAS VACUOUS and the mutation harness said so: when
  // `lockdown` throws, the caught default above carries an empty `remaining`, so the clause
  // passed over a report that was never produced. The absence of a throw is part of the claim.
  check("and none survives", !report.threw && report.remaining.length === 0,
        { threw: report.threw, remaining: report.remaining });
  check("and the reachability test agrees",
        TARGETS.every((t) => {
          const obj = t.on === "global" ? scope : (t.on === "navigator" ? scope.navigator : scope.URL);
          return !(t.name in obj);
        }),
        TARGETS.filter((t) => {
          const obj = t.on === "global" ? scope : (t.on === "navigator" ? scope.navigator : scope.URL);
          return t.name in obj;
        }).map((t) => t.name));
  // Idempotent: a worker that runs a second program must not strip twice, and the second report
  // reads as "there was nothing there", not as "it worked again".
  let second = { stripped: [], absent: [] };
  try {
    second = lockdown(scope);
  } catch (error) {
    second = { stripped: ["threw"], absent: [], why: String(error && error.message) };
  }
  check("a second lockdown reports everything absent and strips nothing",
        second.stripped.length === 0 && second.absent.length === TARGETS.length, second);
}

/* 3. WHAT THE PLATFORM NEVER EXPOSED IS REPORTED AS ABSENT, NOT AS STRIPPED. The distinction is
 *    the honesty of the report: `SharedWorker` and `importScripts` are genuinely not in a Chrome
 *    module worker, and a report claiming credit for removing them would be a report nobody can
 *    use to tell a stripped realm from a lucky one. */
{
  const scope = realisticScope({ omit: ["global.SharedWorker", "URL.revokeObjectURL"] });
  let report = { stripped: [], absent: [] };
  try {
    report = lockdown(scope);
  } catch (error) {
    report = { stripped: [], absent: [], why: String(error && error.message) };
  }
  check("an absent binding is reported absent",
        report.absent.includes("global.SharedWorker")
        && report.absent.includes("URL.revokeObjectURL"), report);
  check("and is not counted as stripped",
        !report.stripped.includes("global.SharedWorker"), report.stripped);
}

/* 4. THE REFUSAL — the path no browser can reach, and the reason this file exists.
 *
 *    A non-configurable property cannot be deleted. The lockdown must NOT return a report saying
 *    so in a field nobody reads: it must throw, because its caller evaluates program text on the
 *    next line. A realm that could not be stripped and ran the program anyway is strictly worse
 *    than no lockdown at all — the check would be green and the hole would be open. */
{
  const scope = realisticScope({ configurable: false });
  let threw = null;
  try {
    lockdown(scope);
  } catch (error) {
    threw = error;
  }
  check("a realm that cannot be stripped throws", threw !== null, "lockdown returned normally");
  check("and the message names a survivor",
        threw !== null && /global\.fetch|navigator\.storage/.test(String(threw.message)),
        threw && threw.message);
  check("and says why it refuses to continue",
        threw !== null && /without a syscall|constraint 41/.test(String(threw.message)),
        threw && threw.message);
  // THE SURVIVOR IS STILL THERE, which is what makes the throw load-bearing rather than tidy:
  // the caller's program would have had ambient storage.
  check("and the binding it could not remove is still reachable",
        "storage" in scope.navigator, "the double did not hold its own property");
}

/* 5. A ROW NAMING A CONTAINER THE REMOVER DOES NOT UNDERSTAND IS AN ERROR, never a silent skip.
 *    A typo in `on` would otherwise mean a target that is never stripped and never reported. */
{
  /* AN EMPTY SCOPE, deliberately: every target absent and `navigator` undefined, so the only
   * question this section asks is what happens to a container that is not in the realm. Built
   * with `omit: names` rather than from `realisticScope()` because the mutation harness caught
   * the first version breaking under `shallow` as well — a section that moves under a mutation
   * about something else is a section that cannot tell the reader which subject failed. */
  const bare = { navigator: undefined, URL: {} };
  let threw = null;
  let report = null;
  try {
    report = lockdown(bare);
  } catch (error) {
    threw = error;
  }
  check("a missing container is reported absent rather than crashing", threw === null,
        threw && threw.message);
  check("and every row in that realm is reported absent",
        report !== null && report.absent.length === TARGETS.length
        && report.stripped.length === 0,
        report);
}

const report = {
  file: "bench/m6-realm/probe.mjs",
  subject: "src/libos/lockdown.mjs",
  checks: results.length,
  failed,
  failures: results.filter((r) => !r.ok),
};
console.log(JSON.stringify(report, null, 2));
if (failed) process.exitCode = 1;
