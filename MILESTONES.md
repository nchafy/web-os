# Milestones

The tracker. `PLAN.md` carries the reasoning — why this order, what each option gives up, and what
the critics changed. This file carries only state: what is done, what is next, and the proof each
milestone owes.

**A milestone is not done until its proof passes and its negative control fails.** A milestone
whose check cannot fail is not done however much of it is written. `CLAUDE.md` §Verification is the
contract.

Estimates are working days for one developer. Record the actual beside it — an estimate nobody
checks is a wish.

---

## Status

| | Milestone | Est | Actual | Status |
|---|---|---|---|---|
| — | Day zero: tree, isolation server, CDP driver | 0.5 | 0.5 | ✅ done |
| — | Harness: `cdp.py`, `--prove-failure`, spine checks | 2 | 1.2 | ✅ done — `check.py`, registry, 4 negative controls, `check_boot`; spine checks land per milestone |
| M0 | Prove the syscall channel under contention | 1 | 1 | ✅ done — **ACCEPT**, p99 255 µs at N=16 |
| **M0a** | **Addendum: the same sweep with a real OPFS call in the mix** | 0.5 | | ⬜ **next** |
| **M1** | **Process lifecycle, signals, hard cap** | 4 | | ⬜ **next** |
| M2 | VFS core on OPFS | 8 | | ⬜ |
| M3 | `/proc`, `/dev`, mounts | 2 | | ⬜ |
| M4 | Pipes, pty, line discipline | 5 | | ⬜ |
| M4a | The terminal gets a real window | 2 | | ⬜ |
| M5 | The shell and ten programs | 6 | | ⬜ |
| M6 | Neuter the process realm | 2 | | ⬜ |
| | **— end of spine. Choose option A / B / C here —** | **30** | | |
| M7 | A window is a file description | 4 | | ⬜ A |
| M8 | The window surface | 3 | | ⬜ A |
| M9 | Owner, modality, close-request | 3 | | ⬜ A |
| M10 | Typed clipboard and drag-and-drop | 4 | | ⬜ A |
| M11 | Aero glass, frame-only, plus reskin | 5 | | ⬜ A |
| M12 | The blur governor | 3 | | ⬜ A |
| M13 | The geometry harness | 5 | | ⬜ A |
| M14 | Snap, Superbar, jump lists, tray | 6 | | ⬜ A |
| — | Icons and fonts, redrawn | 4 | | ⬜ A |
| | **Option A total** | **70** | | |

Options B (+65, WASI binaries) and C (+100, canvas compositor) are in `PLAN.md` §6. They are not
started and should not be until the spine is done.

---

## Day zero — done

Tree, `scripts/serve.py` (COOP/COEP, with `--no-isolation` to prove a check fails without it),
`scripts/cdp.py` carried from the predecessor, and `www/index.html` as a preflight that refuses to
proceed when a required capability is missing.

**Proof:** open `www/index.html` under `scripts/serve.py` — every required row reads `present`.
**Negative control:** `scripts/check.py --negative no-isolation` — exactly four rows go red:
`crossOriginIsolated`, `SharedArrayBuffer`, `worker is isolated` and `worker can block`, and the
verdict refuses. `OPFS sync handle` stays `present`: `createSyncAccessHandle` in a dedicated worker
does not require cross-origin isolation, so a control that expected it to go red would be expecting
the wrong thing.

## Harness — done

`scripts/cdp.py` is the only CDP driver (392 lines). `scripts/serve.py` owns the server and the one
declaration of COOP/COEP. `scripts/check.py` is the harness: one registry, one definition of
inversion, and a module docstring whose failure-mode table is normative — **every row names a
detector and an exit code, and a row whose detector cannot fire is the defect the table exists to
forbid.** Add a mechanism, add its row.

Inversion is not a tuple of names but a per-check declaration, because a list maintained beside the
checks is a list that drifts: `Control.INVERT` is **mandatory**, and the opt-out needs a reason
string that `audit()` reads. A check cannot be registered that nothing can invert, that declares a
negative control nobody scores, that asserts fewer expectations than the committed floor in
`scripts/check_floors.json`, or that lives in a file nothing imports.

Four negative controls, each scored on **which** expectations moved rather than on the outcome enum
alone — a control satisfied by any failure is a control that never verifies its own subject:
`--negative no-isolation`, `empty-root`, `patched-required`, `patched-optional`.

**A check whose measurement does not exist without a capability declares that**, with a reason, and
the control is satisfied by the measurement going away. An *undeclared* unmeasurable check is still
a stray and still fails the gate. This is what lets a kernel check — M0's reads a
`SharedArrayBuffer`, which is not constructible without COOP/COEP — be registered at all.

**Still owed:** the spine checks themselves, which land with the milestone that earns them —
`check_mount`, `check_mount_index`, `check_filesystem`, `check_fs_persistence`, `check_terminal`.
The predecessor's versions are a starting point, not a port: its filesystem was imported directly by
its apps, so every check that reached the VFS reached it without a syscall.

---

## M0 — Prove the syscall channel under contention · ✅ done · est 1 day, actual 1 · ~2,000 LoC

**Verdict: ACCEPT.** p99 at N=16 is **255 µs** on the worst of three runs, against a 500 µs accept
bar and a 2 ms kill bar. The plan stands and M1 is cleared to start.

The LoC estimate was wrong by 8×: ~250 was budgeted and ~2,000 written. Almost none of the overrun
is kernel — `src/` is ~1,500 lines including the ABI table and the libos stub, and the rest is the
bench. The estimate priced the mechanism and forgot that a measurement nobody can impeach costs
more than the thing it measures.

**Built.** `src/abi.mjs` (every integer both sides agree on, in one place), `src/kernel/` (boot,
globals SAB, heartbeat, two-phase spawn, dispatch, process table, fd table, the dense syscall
table), `src/libos/` (the blocking stub and the process entry), `www/m0.html`,
`bench/syscall-contention/`. Three calls: `getpid`, `write(1, …)`, `clock_nanosleep`.

**Measured.** The curve is `docs/CONSTRAINTS.md` constraint 51; the clock it rests on is constraint
52. Closed-loop, barrier-released so all N are inside the measured window together (overlap
≥99.9%), release ramp and ramp-down excluded, one fresh browser per cell with quiescence asserted
before any figure.

**Negative control, fired.** A 2 ms synchronous stall in the kernel handler gives p99 **29,673.6 µs**
and the harness returns `KILL`. So the ACCEPT above is demonstrably capable of being a KILL, which
is the only thing that makes it worth reading. `--negative kernel-stall` keeps it re-runnable.

**The anti-vacuity control, which is the one that matters.** A rate-limited process loop must make
the concurrency gates fail *while the latency stays sane* — otherwise a harness that never saturated
the kernel could report a clean p99 at "N=16". It does: clean N=16 gives depth_p50 13 of 16 and
queued-fraction 0.999; the rate-limited control gives 0 and 0.000, failing seven of nine gates and
producing NO VERDICT. The first attempt at this control was itself broken — it used a busy-spin, so
sixteen spinning workers on twelve cores starved the kernel and destroyed the latency it was meant
to leave alone (p99 8,270 µs). It is an idle park now.

### What M0 changed in the plan

- **`depth_min >= 2` was the wrong gate and is now a witness.** It read 1 on a saturated kernel and
  1 on a rate-limited one, so it never discriminated, while firing on every healthy run. The cause
  is real and unavoidable: the in-flight count is decremented before the woken process re-issues, so
  every process has an un-outstanding interval equal to its own wake latency, and over 500,000
  dispatches those coincide. Replaced by `depth_p50 >= max(2, 0.5N)` plus `depth_max >= 0.75N`,
  which the rate-limited control still fails. A gate that fires on every good run is a gate on its
  way to being ignored.
- **`CALLID` is a per-call identity, not the syscall number**, and the number moved to its own word.
  `docs/ABI.md` now says so; the two readings of the old table produced two incompatible kernels.
- **M1's liveness bar is restated.** M1 asked for a parked process to return `EIO` "within 2× the
  re-arm interval" (100 ms), which was written before anyone measured how long a saturated kernel
  goes without servicing its own timer. The bar is now
  `REARM_MS × (HB_MISS_LIMIT + 1)` = **200 ms**, and constraint 56 carries the measured tick-gap
  distribution that sets it. Observed: `-EIO` at 168–189 ms from `terminate()`, inside the bound.
- **The hard cap is advisory until M6.** A process can spawn a worker at depth 3 that holds the
  kernel's SAB, can block, and is invisible to the process table — so the cap counts a number that
  is not the real one. Constraint 53; the realm lockdown gains `SharedWorker` and
  `URL.createObjectURL`, and M6 stops being only about the filesystem.
- **Past ~16 callers, queueing dominates.** p99 is 3.06 ms at N=128 and 99.98% of calls there are
  past 500 µs. Not a kill — the bar is N=16 — but the sharded-kernel question M0 deferred becomes
  live somewhere between 16 and 64, not never. The kernel is also only ~44% busy inside its handlers
  when saturated (constraint 54), so the cost to attack is per-message dispatch, not handler work.

**Two harness defects the sweep itself exposed**, both fixed: the bench mislabelled a spawn the hard
cap had correctly refused as "kernel-starved-children" (the cell asked for 129 processes against a
cap of 128, because `--hb` adds an observer), and `probe.py` discarded a completed measurement with
a traceback when `--out` named a directory that did not exist.

**Watch for** — confirmed, and handled from the first line: 0.036–0.183% of round trips return
`"not-equal"` from `Atomics.wait` because the kernel replied before the process parked. A fast path,
not an error. The kernel's own notify-woke-nobody counter agrees with the process-side count to
98.2–100%.

---

## M0a — Addendum: the same sweep with a real OPFS call · next · 0.5 day

**Why this exists.** M0's three calls were `getpid`, `write(1, …)` to an in-memory sink, and
`clock_nanosleep`. None touches storage, so the handler it measured costs 2–3 µs. A real `open()`
is 495 µs and a `flush()` is 260 µs — 85–250× that — and the kernel is one thread serving every
process, so one slow `open` is head-of-line blocking for all of them. **M0 measured the one
workload in which that risk cannot appear**, which makes its ACCEPT conditional on a condition it
never stated. Raised by a parallel session reviewing the result; the gap is real and was mine.

**Build.** A fourth call that opens and writes a real OPFS file, added to the existing mix. No new
harness — the eight controls, the anti-vacuity gates and the barrier all stand.

**Proof.** Run the mix at N ∈ {1, 16, 64} and report **p99 for the cheap calls while the expensive
ones are in flight**, separated by call. That is the figure that matters: it says whether a
`getpid` queued behind someone else's `open` returns in 15 µs or in 500. Report the two
distributions side by side, not a pooled number — pooling is what would hide it.

**Negative control.** The existing kernel-stall control already proves the harness can see a slow
handler. What this milestone additionally owes is the *separation*: show that the cheap-call p99
moves when the expensive call is added and does not when it is removed, so the figure is coupled to
the I/O and not to the extra traffic.

**What a bad result means, and it is not a kill.** If cheap calls inherit the `open` latency, the
first fallback is **a second kernel-side I/O worker owning the OPFS handles** — constraint 15
forbids a releasable resource living in a *process*, and an I/O worker is kernel-side, so the
handles stay legal while the dispatch thread stops blocking. That is much smaller than the sharded
kernel M0's kill criterion named. Constraint 57.

**Also specify while here:** the queue drain order. A kernel that replies out of order can livelock
without one — notifications, then in-flight answers, then new requests.

---

## M1 — Process lifecycle, signals, hard cap · 4 days · ~1100 LoC

Delivers the headline: a process in `for(;;){}` with no syscalls dies on End Process.

**Build.** `spawn`, `exit`, `waitpid`, `kill`, `sigaction`, `setpgid`, `sched_yield`. Monotonic,
never-reused pids. Hard cap 128; the 129th returns `-EAGAIN`. Signals through the SAB control word
(16). Finite re-arm interval plus a kernel heartbeat word (46). Teardown split from reap (14).

**Proof.** (a) compute-bound process dies on End Process; (b) `kill -9` under contention;
(c) the 129th spawn fails cleanly; (d) kill the kernel worker and every parked process returns
`EIO` within **`REARM_MS × (HB_MISS_LIMIT + 1)` = 200 ms** — **without reloading the page**.

(d)'s bar was "2× the re-arm interval" until M0 measured the kernel's own tick gap under
saturation: p999 reaches 58.5 ms at N=128 against a nominal 10 ms period, so a 100 ms bar would
fault live processes under load. Constraint 56 carries the distribution. M0 already observes
`-EIO` at 168–189 ms from `terminate()`, so (d) is close to free; what M1 owes is the *cap* case
and the teardown, not the mechanism. Note (c) is now partly measured too — M0's cap correctly
refused a 129th spawn, and the bench's mislabelling of that refusal is what exposed it.

**Negative control.** Remove the SIGPEND check at syscall entry; Ctrl-C must stop working.

---

## M2 — VFS core on OPFS · 8 days · ~1400 LoC

**Build.** Days 1–4: port `../webxp/shared/fs/vfs.mjs` (1,301 lines) — `#lookup` with
`MAX_LINKS=40`, the permission checks, the error codes, `serialize`/`parse` as snapshot writer and
half of fsck. Two changes touch nearly every method: data becomes bytes, and the credential becomes
a per-call argument (29).

Days 5–8: the inode→`{handle, refcount}` table (47); boot-lock retry ~3 s with backoff (48);
`fsync` separate, journal flushed on fsync/snapshot/idle (23); fsck never reseeds (28). Write
ordering: blob → flush → journal → flush → apply in memory.

**Proof.** (a) 10k files, reload, every byte and every mode bit intact; (b) truncate the journal
mid-record — fsck reports the discarded tail rather than reseeding; (c) two concurrent opens of one
file both succeed.

**Negative control, two stages.** Drop the data-before-metadata ordering — fsck must report
corruption. Then break the CRC check and confirm the torn-journal test *starts passing*; if it
passes either way it was testing nothing.

---

## M3 — `/proc`, `/dev`, mounts · 2 days · ~450 LoC

**Build.** Longest-prefix mount table, static at boot: `/` OPFS rw, `/usr` read-only from a
build-time JSON index, `/tmp` tmpfs, `/proc` and `/dev` generated on read.
`/proc/<pid>/{status,cmdline,cwd,fd/<n>}` is ~120 lines and is the clearest demonstration that a
process is a first-class object.

**Proof.** `ls /proc` enumerates live pids; kill one and its directory vanishes.
**Negative control.** Serve a cached `/proc` listing instead of regenerating — the killed pid must
linger and the check must fail.

---

## M4 — Pipes, pty, line discipline · 5 days · ~1000 LoC

**Build.** `pipe2`, `dup2`, process groups, and the line discipline **in the kernel** —
`ICANON`, `ECHO`, `ISIG`, `VINTR`/`VQUIT`/`VSUSP` — so Ctrl-C raises `SIGINT` on the foreground
group even when the UI is wedged. Every byte of IPC crosses the kernel (15).

**Proof.** `yes | head -1` terminates; Ctrl-C during `sleep 100 | cat` kills both; a writer killed
with `-9` makes its blocked reader return 0 (EOF), and a blocked writer whose reader died gets
`-EPIPE` plus `SIGPIPE` — the two directions differ, see `docs/ABI.md` §5.
**Negative control.** Stop delivering SIGPIPE; `yes | head -1` must hang.

---

## M4a — The terminal gets a real window · 2 days · ~200 LoC

Exists so there is something on screen before day 30. Drop in `../webxp/src/window.mjs` unstyled
and point it at the pty.

**This window is special-cased, not an ABI. M7 generalises it and deletes the special case.** Say
so in the code or it becomes the architecture by accident.

**Proof.** Type into the window; assert the pty echoed it.
**Negative control.** Detach the pty; the keystroke must not appear.

---

## M5 — The shell and ten programs · 6 days · ~1200 LoC

**Build.** Keep `../webxp/apps/terminal/shell.mjs`'s front end (453 lines: tokenize, parse, expand,
complete); rewrite the executor against the combined 1,941-line shell+commands pair to use `pipe2`
+ `spawn` with `posix_spawn`-shaped file actions. Ten programs in `/usr/bin`: `ls`, `cat`, `echo`,
`wc`, `head`, `grep`, `sleep`, `kill`, `ps`, `true` — **mostly new code**; the predecessor
contributes ~230 lines across six, and `kill` and `ps` have no equivalent because it had no process
table.

No `fork` (20). `( subshell )` in-process is fine, and in fact more POSIX-conformant for `$$`,
`$!` and `PPID`. **The real casualty is `f | g` with both sides shell functions** — one Worker
cannot run both, and serialising deadlocks when the pipe buffer fills. Budget a second shell
worker, or accept and document the deadlock (20a).

**Proof.** `ls /usr/bin | grep c | wc -l` is correct through three real processes; then
`sleep 60 &`, `ps`, `kill %1`.
**Negative control.** Make `spawn` return the parent's pid; `ps` must show one process and the
check must fail.

---

## M6 — Neuter the process realm · 2 days · ~300 LoC

Closes the hole that makes everything above decorative. A process worker is same-origin, so it has
ambient OPFS access and can open the kernel's blob store by inode and write it — no credential
checked, no syscall made. Confirmed against every candidate design.

**Build.** `src/libos/` strips the realm before evaluating program text: delete
`WorkerNavigator.prototype.storage`, plus `fetch`, `XMLHttpRequest`, `importScripts`, `indexedDB`,
`caches`, `WebSocket`, `Worker` (41).

**Proof.** A program containing the bypass snippet fails, and `/proc` shows it faulted.
**Negative control.** Skip the stripping; the same program must **succeed**. If it does not, the
check is testing nothing.

**Label honestly in the docs:** hardening, not a security boundary. Same-origin is not a security
boundary. Threat model is first-party only for v1.

---

## The window half (option A) — M7 to M14

Full table with per-row proof and negative control in `PLAN.md` §5. Summarised here only as status
above. The ABI is ~40 calls, not 34, and the window ABI is `win_*` rather than a `/dev/wm` device
file — a file write cannot transfer an `OffscreenCanvas`.

Two traps recorded there and worth repeating:
- **M11's glass check must sample across a high-contrast seam.** Over a flat backdrop
  `blur(flat) == flat` and the check passes with blur switched off (50).
- **M12's gate is 52 glass terminals, not 5 maximized windows.** Five maximized windows are 18.4 M
  device px, comfortably under the 58–63 M wall, so a gate sized at five passes by construction.
  That error was in the first draft of the plan and `docs/CONSTRAINTS.md` constraint 49 records the
  correction.

---

## Open experiments

Three cheap measurements that should happen before the milestone that depends on them. `PLAN.md`
§10 has the full list of unresolved items.

| Experiment | Before | Cost | Why |
|---|---|---|---|
| Can `Atomics.notify` interrupt a worker inside a synchronous OPFS read? | M4 | 0.5 d | If not, `read()` is not interruptible and the ABI is lying about Ctrl-C. Weakest point in the cancellation design. |
| Why is spawn 1.3–1.6× constraint 19's figure on this build? | M1 | 0.25 d | M0 excluded `Blob`/`createObjectURL` and classic-vs-module; what is left is the patch build, script size, and sample count. Re-run gap-04's own spawn harness here. M1 spawns constantly, so an unexplained 1.5× is worth a quarter day. |
| Does the worker ceiling knee between 256 and 3,200? | M1 | 0.5 d | M0 stopped at 256 with zero failures but per-worker cost was still rising. Constraint 17 sets the design limit at 1,000, which sits inside the unmeasured gap. |
| Is a journal append plus `flush()` durable across a kill? | before storing anything real | 1 d | The spec says "attempt to transfer" and allows a no-op. Build the zip-export affordance regardless. |
| Calibrate the blur ceiling at boot instead of hard-coding one machine's number | M12 | 0.5 d | Turns an unknown into a runtime measurement, which is strictly better than more research. |
