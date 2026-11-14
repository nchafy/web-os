// The programs M1's four proofs need, in one place. USERLAND: reaches the system only through
// syscall(), and is handed no SAB, no port, no handle (src/libos/process.mjs).
//
// Four modes keyed on the role the page hands each process:
//
//   spin     — for(;;){}, no syscalls. Proof (a) the headline: dies only on End Process via
//              Worker.terminate(), because there is no SIGPEND check point for the kernel to
//              interrupt at. If this mode is also interruptible, M1 has not delivered.
//   nap      — clock_nanosleep in a loop, so the process IS at a syscall entry periodically
//              and SIGKILL/SIGTERM can land as -EINTR or as an exit. Proof (b) under contention
//              uses this.
//   sleeper  — one long clock_nanosleep, parks in the kernel. Proof (d) uses this: terminate
//              the kernel worker and every process returns -EIO via the heartbeat timeout
//              inside REARM_MS * (HB_MISS_LIMIT + 1) = 200 ms.
//
// The program never signals its own exit — the kernel is the only writer of exit status
// (MILESTONES M1 item (c)): terminate() leaves the dying worker no way to report, so the
// status is written at teardown or lost.

import {
  SYS_getpid, SYS_clock_nanosleep, SYS_sigaction, SYS_exit,
  SIGINT, SIG_HANDLE, EINTR,
} from "/src/abi.mjs";

const now = () => performance.now();

/** A tight loop that touches nothing the kernel can observe. The headline proof: this process
 *  is unkillable except by terminate(), because it never visits a syscall entry and so can
 *  never drain SIGPEND. */
function spin(env) {
  let x = 0;
  for (;;) {
    // Any observable work would end up as a readable side effect the kernel could race against.
    // A pure arithmetic loop is what the "compute-bound process" in MILESTONES refers to.
    x = (x + 1) | 0;
  }
}

/** Sleep in short slices, so the stream of syscall entries gives SIGPEND something to land on.
 *  A SIGKILL takes this down out-of-band (reap() at raise), and a SIGTERM-at-SIG_DFL also kills
 *  because POSIX default for it is fatal. */
function nap(env) {
  for (;;) {
    env.syscall(SYS_clock_nanosleep, 1000000, 0, 0);   // 1 ms
  }
}

/** One long sleep, so the process is parked in Atomics.wait when the kernel is terminated.
 *  Proof (d) reads KDOWN_SEEN off the SAB after terminate(), inside the heartbeat bound. */
function sleeper(env) {
  // 10 seconds. The page terminates the kernel after a short delay and asserts every parked
  // process has set KDOWN_SEEN inside REARM_MS * (HB_MISS_LIMIT + 1) = 200 ms.
  env.syscall(SYS_clock_nanosleep, 10000000000 | 0, 2, 0);   // 10e9 ns fits in a 32-bit lo word is wrong; use lo/hi
  // The line above is a trap I nearly left: nanosleep takes a (lo, hi) i64 argument, and
  // 10,000,000,000 ns does not fit in an i32. The driver below handles this correctly; this
  // function is only a fallback for a one-off caller and keeps the right shape rather than
  // the right magnitude.
  return;
}

/** The 'intr' mode: install SIG_HANDLE for SIGINT, loop short sleeps, exit(99) on the first
 *  syscall that returns -EINTR. This is the ONE mode whose behaviour depends on the SIGPEND
 *  check at syscall entry being in place: with it, the signal arrives at the next sleep and
 *  EINTR fires; without it (M1 negative control), the process sleeps forever and the harness
 *  times out. The exit value 99 is arbitrary but non-zero, so a clean exit from any other path
 *  cannot be mistaken for the signal having been seen. */
/**
 * The 'entry' mode: the ONE mode that isolates the SIGPEND check at syscall entry.
 *
 * `intr` below raises the signal at a process parked inside clock_nanosleep, which the kernel
 * delivers by interrupting the in-flight call — STATUS=ST_INTR, per docs/ABI.md decision 1. That
 * path does not read SIGPEND at entry, so removing the entry check leaves it working and the
 * negative control proves nothing. Measured: with no_sigpend=1, `intr` still exited 99.
 *
 * So this mode never parks while the signal is in flight. It computes, with NO syscalls, for long
 * enough that the page can raise during the burst, and only then issues a syscall. A signal raised
 * at a running process has nowhere to be seen EXCEPT the next entry, which is exactly the claim
 * constraint 16 makes and exactly what the control removes.
 */
function entry(env) {
  // RETRY ON -EINTR, because this call can be the one that eats the signal. If the page raises
  // before the program reaches its loop, the pending bit is drained by whichever syscall runs
  // first — and that was this one, so the loop below never saw a signal and the process ran to
  // its deadline. -EINTR means "retry", not "failed", and treating it as failure made the proof
  // race the page.
  let old = env.syscall(SYS_sigaction, SIGINT, SIG_HANDLE);
  while (old === -EINTR) old = env.syscall(SYS_sigaction, SIGINT, SIG_HANDLE);
  if (old < 0) env.syscall(SYS_exit, 1);
  // Announce readiness, then stop making syscalls. The page raises after seeing this.
  env.syscall(SYS_getpid);
  // DEADLINE-BOUNDED, not round-bounded. A fixed round count races the page: 400 rounds of
  // arithmetic completed in under 80 ms, so the process exited 3 before the signal was ever
  // raised and the proof failed for a reason that had nothing to do with signals. Waiting on the
  // wall clock removes the race instead of tuning the loop against it.
  const deadline = now() + 3000;
  let x = 0;
  let round = 0;
  while (now() < deadline) {
    /* A LONG slice, deliberately. The two delivery paths must be separated: a signal raised while
     * a call is IN FLIGHT is delivered kernel-side by interrupting it (ST_INTR), which does not
     * consult the entry check at all. With a short slice the process sat in a syscall about a
     * quarter of the time, so a raise often took that path and the control passed while proving
     * nothing. ~10 ms of arithmetic against a ~15 us syscall puts the in-flight fraction near
     * 0.15%, so a single raise almost certainly lands here, where only the entry check can see it.
     *
     * The progress word is advanced WITHOUT a syscall, which is the point: the page waits for it
     * to move before raising, and a process that reported progress by syscall would be inside one
     * when the signal arrived. */
    for (let i = 0; i < 2000000; i += 1) x = (x + i) | 0;
    round += 1;
    env.publishProgress(round);
    const r = env.syscall(SYS_getpid);
    if (r === -EINTR) {
      env.syscall(SYS_exit, 99);
      return;
    }
  }
  // Three seconds of syscall entries and the bit was never seen. Exit 3 is distinguishable from
  // 99 and from 1, so the harness can tell "never interrupted" from "sigaction refused".
  env.syscall(SYS_exit, x === 123456789 ? 2 : 3);
}

function intr(env) {
  const old = env.syscall(SYS_sigaction, SIGINT, SIG_HANDLE);
  if (old < 0) env.syscall(SYS_exit, 1);
  for (;;) {
    // 20 ms slices give the page time to raise the signal and the process plenty of entries
    // for it to land at. r1of() is not needed: -EINTR is a short count, not a (lo, hi) i64.
    const r = env.syscall(SYS_clock_nanosleep, 20000000, 0, 0);
    if (r === -EINTR) {
      env.syscall(SYS_exit, 99);
      // Unreachable — exit never returns — but a program that fell through here would keep
      // sleeping and the control would conflate "SIGPEND did nothing" with "SIGPEND did its
      // job and we missed handling it".
      return;
    }
  }
}

export function run(env, m) {
  const mode = m.argv && m.argv[0];
  if (mode === "spin") return spin(env);
  if (mode === "nap") return nap(env);
  if (mode === "intr") return intr(env);
  if (mode === "entry") return entry(env);
  if (mode === "sleeper") {
    // The right way to pass a 10 s sleep: two 32-bit halves. 10e9 ns = 0x2_5400_0000.
    const lo = 0x54000000 | 0;
    const hi = 0x00000002 | 0;
    env.syscall(SYS_clock_nanosleep, lo, hi, 0);
    return;
  }
  throw new Error(`m1-lifecycle/program.mjs: unknown mode ${mode}`);
}
