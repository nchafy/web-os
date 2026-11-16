// `sleep`: do nothing, for a while.
//
// The contract this program is written against is in src/bin/true.mjs.
//
// THE PROCESS IS PARKED, NOT SPINNING. `clock_nanosleep` parks the worker in `Atomics.wait` with a
// finite re-arm (constraint 46), so a sleeping process costs no CPU and is still killable and
// still interruptible — which is what makes `sleep 60 &` then `kill %1` a meaningful proof rather
// than a test of a busy loop.

const NAME = "sleep";

const NS_PER_S = 1000000000;

/**
 * POSIX's `sleep` takes an integer; every real one takes a decimal. A decimal is accepted here
 * because a check that wants to sleep 20 ms should not have to spell it as 0 seconds.
 *
 * Returns nanoseconds, or null. A leading `+`, a bare `.`, an exponent and `Infinity` are all
 * refused: `Number("1e9")` is a billion seconds, and a typo that sleeps for thirty years must be
 * a usage error rather than a hang.
 */
export function nanosecondsOf(spec) {
  if (typeof spec !== "string" || !/^\d+(\.\d+)?$/.test(spec)) return null;
  const seconds = Number(spec);
  if (!Number.isFinite(seconds)) return null;
  const ns = Math.round(seconds * NS_PER_S);
  return Number.isSafeInteger(ns) ? ns : null;
}

export function run(env) {
  const std = env.std;
  const args = (env.argv || []).slice(1);
  if (args.length === 0) {
    return { exit: std.complain(env, NAME, null, "usage: sleep seconds...", std.EXIT_USAGE) };
  }
  let total = 0;
  for (const arg of args) {
    const ns = nanosecondsOf(arg);
    if (ns === null) {
      return { exit: std.complain(env, NAME, arg, "not a number of seconds", std.EXIT_USAGE) };
    }
    // POSIX: several operands are ADDED. `sleep 1 2` is three seconds, not one then two — which
    // matters because it is also how `sleep` is told to sleep longer than one argument can say.
    total += ns;
  }
  const r = env.proc.nanosleep(total);
  // -EINTR IS NOT A FAILURE TO REPORT ON STDERR. A signal with a handler cut the sleep short, so
  // this slept for less time than asked and says so in its status — which is what a caller
  // waiting on it needs. A signal with no handler is FATAL and this process was already reaped
  // inside the call, so the common Ctrl-C case never reaches here at all.
  if (r < 0) return { exit: 1, errno: -r, interrupted: true, ns: total };
  return { exit: 0, ns: total };
}
