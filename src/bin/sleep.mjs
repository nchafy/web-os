// `sleep`: do nothing, for a while; program contract in src/bin/true.mjs. `clock_nanosleep` parks
// the worker in `Atomics.wait` with a finite re-arm (constraint 46), so a sleeping process costs no
// CPU and stays killable and interruptible.

const NAME = "sleep";

const NS_PER_S = 1000000000;

/** Returns nanoseconds, or null. An exponent and `Infinity` are refused: `Number("1e9")` is a
 *  billion seconds, and a typo that sleeps for thirty years must be a usage error, not a hang. */
export function nanosecondsOf(spec) {
  if (typeof spec !== "string" || !/^\d+(\.\d+)?$/.test(spec)) return null;
  const seconds = Number(spec);
  if (!Number.isFinite(seconds)) return null;
  const ns = Math.round(seconds * NS_PER_S);
  if (!Number.isSafeInteger(ns)) return null;
  // A non-zero request that rounds to zero is refused: a zero-nanosecond sleep is answered on the
  // next macrotask, so a caller that meant to park never does. `sleep 0` is still a no-op.
  if (ns === 0 && seconds > 0) return null;
  return ns;
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
    total += ns;
  }
  const r = env.proc.nanosleep(total);
  // -EINTR is reported in the status, not on stderr: a handled signal cut the sleep short, which is
  // what a waiting caller needs to know. An unhandled signal is fatal and reaped inside the call.
  if (r < 0) return { exit: 1, errno: -r, interrupted: true, ns: total };
  return { exit: 0, ns: total };
}
