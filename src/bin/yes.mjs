// `yes`: write its argument, or `y`, until something stops it.
//
// The contract this program is written against is in src/bin/true.mjs.
//
// ======================================================================================
// THE ELEVENTH PROGRAM, and MILESTONES.md M5 asks for ten. It is here because a property four
// other programs are written around was otherwise ASSERTED BY COMMENT ONLY:
//
//     `yes | head -1` must terminate.
//
// That is M4's headline proof (docs/ABI.md decision 5: a writer whose last reader went gets EPIPE
// plus SIGPIPE), and it is the reason `cat`, `head`, `grep` and `src/libos/std.mjs`'s `eachLine`
// all stream instead of slurping. Until this file existed the sentence had no spelling in this
// system: there was no endless source, and the only candidate — `/dev/zero` — is an honest finite
// 256-byte file. So every one of those comments cited a case no check could reach.
//
// A PROGRAM THAT IGNORES ITS WRITE'S RETURN IS THE POINT, and it is deliberate rather than sloppy.
// `bench/m4-fs/program.mjs` records why: breaking out of the loop on a negative return made M4's
// control unobservable, because with SIGPIPE non-fatal the first write after the reader goes
// returns -EPIPE and a careful writer exits quietly. The naive program — the one every real
// pipeline contains — keeps writing, and dies of the signal. This is that program.
// ======================================================================================

const NAME = "yes";

/**
 * A bound on "forever", in writes.
 *
 * NOT A CORRECTNESS BOUND: a working `yes` in a pipeline is killed by SIGPIPE long before it, and
 * the kernel's pipe parks the writer when the buffer fills so this is not a spin either. It is
 * there so a BROKEN dead-peer path ends as a program that reports rather than a harness that
 * times out with no information — the same reason `bench/m4-fs/program.mjs` caps its own loop and
 * reports `hitCap`.
 */
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
    // DELIBERATELY NOT BROKEN OUT OF. See the header: a writer that stops on -EPIPE makes the
    // SIGPIPE disposition unobservable, and this program exists to be killed by it.
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
