// `yes`: write its argument, or `y`, until something stops it; program contract in
// src/bin/true.mjs. Ignoring the write's return is the point — a writer that stops on -EPIPE exits
// quietly and leaves the SIGPIPE disposition unobservable, and this is the naive program that keeps
// writing and dies of the signal (M4's `yes | head -1` proof, bench/m4-fs/program.mjs).

const NAME = "yes";

/** A bound on "forever", in writes. Not a correctness bound — SIGPIPE kills a working `yes` long
 *  before it — so a broken dead-peer path reports instead of timing out with no information. */
const WRITE_CAP = 1000000;

export function run(env) {
  const args = (env.argv || []).slice(1);
  const line = `${args.length ? args.join(" ") : "y"}\n`;
  const bytes = env.std.bytes(line);
  let writes = 0;
  let errors = 0;
  let last = 0;
  for (; writes < WRITE_CAP; writes += 1) {
    last = env.write(1, bytes);
    if (last < 0) errors += 1;
  }
  // Reached only if nothing ever stopped it, which is the failure the cap exists to report.
  env.std.warn(env, `${NAME}: wrote ${writes} times and was never stopped`);
  return {
    exit: 1,
    writes,
    errors,
    lastErrno: last < 0 ? -last : 0,
    hitCap: true,
  };
}
