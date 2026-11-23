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
| — | Harness: `cdp.py`, `--prove-failure`, spine checks | 2 | 1.2 | ✅ done — `check.py`, registry, **35 negative controls over 18 checks and 695 expectations**; the spine checks landed per milestone |
| M0 | Prove the syscall channel under contention | 1 | 1 | ✅ done — **ACCEPT**, p99 255 µs at N=16 |
| M0a | Addendum: the same sweep with a real OPFS call in the mix | 0.5 | 0.5 | ✅ done — **the I/O worker is required**, not optional |
| M0b | Move the OPFS handles to a second kernel-side worker | 1.5 | 0.5 | ✅ done — cheap p99 185 µs at N=16, K=1 |
| M1 | Process lifecycle, signals, hard cap | 4 | 1 | ✅ done — a spinner dies on End Process |
| M2a | A host-runnable kernel, fuzzable codecs | 1 | 0.5 | ✅ done — 10k torn journals, 0 accepted |
| M2 | VFS core on OPFS | 8 | 3 | ✅ done — 10k files intact, 8 verification rounds |
| M3 | `/proc`, `/dev`, mounts, provider iface, /dev/trace | 4 | 1 | ✅ done — **ACCEPT**, 55 expectations, 3 controls, 9 review findings fixed |
| M4 | Pipes, process groups | 5 | 1 | ✅ done — **ACCEPT**, 23 expectations, 1 control, 12 review findings fixed |
| M4b | pty, line discipline, `poll` | 2 | 1 | ✅ done — **ACCEPT**, 54 expectations, 4 controls |
| M5 | The shell, eleven programs, exec through the filesystem | 6 | 1.5 | ✅ done — **ACCEPT**, 38 expectations, 6 controls, 14 review findings fixed |
| M4a | The terminal gets a real window | 2 | 1 | ✅ done — **ACCEPT**, 22 expectations, 1 control (26 before M7 took the detector's four) |
| M6 | Neuter the process realm | 2 | 0.5 | ✅ done — **ACCEPT**, 31 expectations, 2 controls, 6 review findings fixed, and constraint 139's prescription corrected |
| | **— end of spine. Choose option A / B / C here —** | **35** | | |
| M7 | A window is a file description | 4 | 1 | ✅ done — **ACCEPT**, 42 expectations, 2 controls, 128 host checks, 5 mutations, 6 review findings fixed |
| M8 | The window surface | 3 | 0.5 | ✅ done — **ACCEPT**, 30 expectations, 1 control, 51 host checks, 5 mutations, 12 review findings fixed, and a prerequisite experiment that reversed the design |
| M9 | Owner, modality, close-request | 3 | 0.5 | ✅ done — **ACCEPT**, 41 expectations, 2 controls, 79 host checks, 8 mutations, 9 critic findings fixed |
| M10 | Typed clipboard and drag-and-drop | 4 | 0.5 | ✅ done — **ACCEPT**, 37 expectations, 2 controls, 164 host checks, 11 mutations, 3 real-prompt runs, 6 critic findings fixed |
| M11 | Aero glass, frame-only, plus reskin | 5 | 0.5 | ✅ done — **ACCEPT**, 35 expectations, 5 controls, 1 real-prompt run, 11 critic findings fixed, and a prerequisite experiment that corrected a decision's headline number |
| M12 | The blur governor | 3 | 0.5 | ✅ done — **ACCEPT**, 27 expectations, 3 controls, 32 host checks, 1 real-prompt run, 11 critic findings fixed, and a prerequisite sweep that found the specified gate cannot fire |
| M13 | The geometry harness | 5 | 0.5 | ✅ done — **ACCEPT**, 38 expectations, 3 controls, 1 product defect found (the resize re-clamp) |
| M14 | Snap, Superbar, jump lists, tray | 6 | 1 | ✅ done — **ACCEPT**, 51 expectations, 4 controls, and M12's own open item closed by a run |
| M15 | The shell's own programs: coreutils, a text op, a readable Explorer, a task manager | — | 1 | ✅ done — **ACCEPT**, 4 reader-reported items, 38 prompt cases, a display-list TEXT op (293), and two second copies retired |
| — | Icons and fonts, redrawn | 4 | 0.25 | ✅ done — 11 icons as vectors with a coverage self-test; the font stack is M11's, referenced and never served. **The new surfaces' CONTRAST is structural, not sampled** — see M14 §What is not done |
| | **Option A total** | **74.5** | **12.75** | **the window half is complete** |
| D0 | RV32I interpreter + one real binary | 6 | | ⬜ D |
| D1 | Sv32 MMU: page tables, TLB, faults | 3 | | ⬜ D |
| D2 | Traps, timer, real preemption | 2 | | ⬜ D |
| D3 | Scheduler policies, swappable | 3 | | ⬜ D |
| D4 | `fork`, copy-on-write, demand paging | 3 | | ⬜ D |
| D5 | Device bus, providers, hot-unplug, RAID | 14 | | ⬜ D |
| D6 | Two tabs, minimal NFS | 3 | | ⬜ D |
| D7 | Page harness, scrubber, check runner | 6 | | ⬜ D |
| D8 | 35 principle pages | 14 | | ⬜ D |
| | **Option D total** | **54** | | |

Option D is **54 days standalone**, plus the 3 that fold into M3 and M5 above = 57 total, which is
the figure in `docs/LEARNING-MODE.md` §9. D0 is 6 rather than 4 because it carries the prebuilt
binaries; D5 is 14 because it carries the device bus, the provider table, PIO-vs-DMA, the latency
harness, hot-unplug and RAID.

Options B (+65, WASI binaries) and C (+100, canvas compositor) are in `PLAN.md` §6. Option D
(+57, the teaching machine and learning mode) is in `docs/LEARNING-MODE.md`. None are started and
none should be until the spine is done.

**Three of option D's days fold into the spine and should be taken regardless**, because for the
first 30 days they are the only visible thing:

| | Folds into | Est | Why now |
|---|---|---|---|
| `/dev/trace` ring + dropped-record counter | M3 | 1 d | **Re-measured at 19.4 ns/record** (the 4 ns below was ~5× low) — 0.28% of a syscall at two records per call. Tracing is still free enough to be always on, and it is the debugger for everything after it. `docs/CONSTRAINTS.md` 72. |
| `top` and `strace` as real programs | M5 | 2 d | A live syscall histogram on day 3 is a better M0 deliverable than a number in a terminal. |

The trace ring needs **≥16 MiB** and a visible dropped-record counter: a 1 MiB ring holds 32,768
records and wraps every 0.5 s at full syscall rate, and a view that silently drops records shows a
clean picture of a broken system.

**Both figures above were re-measured in M3 and one of them was wrong.** A record is 19.4 ns, not
4 ns, because the original estimate did not include a clock read — `Date.now()` alone is 52.9 ns and
`performance.now()` 69.0 ns, which is 85% of a self-timing record. The fix was to pass the
dispatcher's existing timestamps in rather than to accept the cost, so the shipped record reads no
clock. The 32-byte record size is confirmed and is now asserted against this document by
`src/kernel/trace.mjs`'s `selfTest`. `docs/CONSTRAINTS.md` 72–73.

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

## M0a — Addendum: a real OPFS call in the mix · ✅ done · est 0.5 d, actual 0.5

**Verdict: the second kernel-side I/O worker is REQUIRED before M2, not a fallback.** The numbers
and the asymmetry behind them are `docs/CONSTRAINTS.md` constraint 58; the short version is that
**one** process calling `fsync` in a loop takes every other process's p99 from 275 µs to 850 µs at
N=16, and to 2,657 µs at N=64 — past M0's own 2 ms kill bar — with cheap and expensive calls
landing within 1.3× of each other, which is head-of-line blocking by definition.

**The finding that changes the design, and it inverts the obvious reading.** `open` is the
expensive operation (495 µs) and the cheap call to serve, because `createSyncAccessHandle` returns
a promise and is awaited off the dispatch path. `fsync` is the cheap-sounding one (260 µs) and the
expensive call to serve, because `flush()` is synchronous and holds the kernel thread. The review
that prompted this milestone predicted "one slow `open` is head-of-line blocking for every
process"; the mechanism was right and the call was wrong, and only measuring told the difference.

**Built.** `SYS_open` and `SYS_fsync` (ABI numbers 3 and 4, appended, never renumbered), the
`F_FILE` kind on a real sync access handle, and `later()` in the kernel — the async completion
contract constraint 57 demands, reusing `setTimer`'s cancellation identity check rather than
writing a second one. `--call io --io-procs K` runs K processes doing file I/O against N−K issuing
`getpid`, in one barrier-held window, reported apart.

**Proof.** The table in constraint 58, at N ∈ {4, 16, 64}.
**Negative control, and it is the separation itself.** `--call getpid` on the same build returns
cheap p50 to 105 µs, identical to the no-I/O baseline, so the effect is coupled to the I/O and not
to the mix machinery. The I/O-process count also moves it monotonically (1 → 2 → 4 gives 850 →
1,820 → 2,000 µs), which a confounder in the harness would not do.

**Incidental, and it will bite M2 on every path argument:** `TextDecoder` refuses a view backed by
a `SharedArrayBuffer` — "the provided ArrayBufferView value must not be shared" — so a path has to
be lifted into a private buffer before it can be decoded. Found by the first run of this milestone
crashing on it.

---

## M0b — Move the OPFS handles to a second kernel-side worker · ✅ done · est 1.5 d, actual 0.5

**It works.** Cheap p99 at N=16 is 185 µs with one process doing file I/O and 290 µs with two,
against a 500 µs accept bar and the 850–2,657 µs the inline design produced. Cheap p50 returns to
the 85–105 µs no-I/O baseline at every K tested. The full table, the trade and the negative control
are `docs/CONSTRAINTS.md` constraint 59.

**The trade, stated rather than buried:** a write is now a message to another agent, so a single
process doing nothing but `write` + `fsync` gets 30% fewer operations through and its mean rises
43%, though its p50 barely moves. The threshold set before measuring was "more than double and the
trade needs restating"; it did not, so the trade stands.

**The write is zero-copy.** The I/O worker reads the payload out of the calling process's own SAB,
which is safe for one specific reason: that process is parked until the dispatch kernel bumps its
`SEQ`, and the dispatch kernel does not bump it until the I/O worker has answered. A process still
receives nothing but its own SAB and port, so constraint 15 holds — no handle, and no port to the
I/O worker, is reachable from a process.

**One general mechanism came out of it**, and M2 and M4 inherit it: an entry in `KIND_OPS` may
return a promise, and `settle()` in `src/kernel/calls.mjs` turns that into `PENDING` answered via
`later()`. So `SYS_write` is the same four lines whether the description is an in-memory sink or a
file served from another agent, and constraint 57's rule is available to every kind rather than
re-derived per handler.

Scheduled by M0a's measurement, not by preference. Constraint 58.

**Build.** A second kernel-side worker owning the OPFS sync access handles. The dispatch kernel
forwards `write`/`fsync`/`read` to it and answers via `later()`, which already exists and already
drops a reply whose call is gone. Constraint 15 is satisfied because an I/O worker is kernel-side:
the handles never enter a process. Constraint 47's per-inode refcount goes with the handles.

**Specify the queue drain order while here** — notifications, then in-flight answers, then new
requests (constraint 57). A kernel that replies out of order can livelock without one.

**Proof.** Re-run M0a's exact measurement. Cheap p50 must stay at the no-I/O baseline (~105 µs at
N=16) with K I/O processes running, for K ∈ {1, 2, 4}, and cheap p99 must stay under the 500 µs
accept bar at N=16. The table in constraint 58 is the before; this is the after, in the same shape.

**Negative control.** Route the I/O back through the dispatch thread and the M0a numbers must
return. A fix that cannot be switched off has not been shown to be the thing that worked.

**Watch for.** The handles are now in another agent, so a write is a message plus a copy. Measure
the single-process cost too: if uncontended `write` latency more than doubles, the trade needs
restating rather than assuming the contention win pays for it.

---

---

## M1 — Process lifecycle, signals, hard cap · ✅ done · est 4 d, actual 1

**The headline holds: a process in `for(;;){}` with no syscalls dies on End Process.** Reaped 2.4 ms
after the kill, through `Worker.terminate()`, with the record carrying STAT_KILLED/SIGKILL — because
a spinner never reaches a syscall entry and so can never drain SIGPEND (constraint 21). That is the
thing webxp could not do and the reason this project exists.

All five proofs pass and the negative control is exact: `--negative no-sigpend` turns **2 of 14
expectations red and leaves 12 intact** — proof (e) and the verdict, nothing else.

| proof | result |
|---|---|
| (a) compute-bound process dies on End Process | reaped in 2.4 ms, STAT_KILLED/SIGKILL |
| (b) `kill -9` under contention | 16 of 16 reaped in 7.2 ms |
| (c) the 129th spawn fails cleanly | refused by the cap, 128 live, constraint 17 |
| (d) kernel dies, parked processes return `EIO` | 8 of 8, 205–263 ms, no page reload |
| (e) a signal reaches a *computing* process at the next syscall entry | exit 99 |

### Three things the work changed, each found by a proof failing

**Signal delivery needed BOTH paths, and only one existed.** `raiseOne` set the SIGPEND bit and
stopped. A process parked in `clock_nanosleep` would sleep out its full duration and notice the bit
at the *next* entry — which for a blocking read is never. `docs/ABI.md` decision 1 already specified
the other half: the kernel sets STATUS=ST_INTR, bumps SEQ, notifies, and drops the late reply by
CALLID. That is now wired, reusing `setTimer`'s identity check.

**The entry check observed signals instead of delivering them.** `drainSignals()` read the bit,
cleared it, recorded it — and let the syscall proceed. So a signal raised at a *running* process was
seen and discarded. It returns `-EINTR` now, without issuing the call. Any bit present means
interrupt, because the kernel never sets SIGPEND for a signal it is dropping (`SIG_IGN` returns
before the store) or one that is fatal by default (those reap instead), so the disposition is
already applied kernel-side.

**Proof (d) was asserting the wrong direction.** It bounded how LATE a fault may be and said nothing
about how early. Constraint 46 forbids faulting a process on elapsed time alone, so a process that
declared a live kernel dead *before* the threshold is the real defect — and nothing was checking it.
It now asserts all three: every process faults, none faults early, and the slowest is within the
threshold plus two re-arms. The second re-arm is scheduler slip, measured: alone on the machine every
process lands at 205–215 ms, but sharing a browser with the rest of the suite some slip a whole
extra 50 ms (257, 256, 263 against 212–214 for their siblings in the same run).

### What the negative control cost to make honest

The control passed at first while proving nothing, twice, and both times the gate caught it.

Proof (e) originally raised a signal at a process parked in `clock_nanosleep`, so the kernel
delivered it by interrupting the in-flight call — a path that never consults the entry check. With
`no_sigpend=1` the process still exited 99. Pointing the proof at a *computing* process fixed that,
and then raising repeatedly broke it again: a raise that lands while a call is in flight takes the
ST_INTR path, so with enough raises one always got through.

The isolated form is a long compute slice (~10 ms of arithmetic against a ~15 µs syscall, so the
in-flight fraction is near 0.15%) plus **one** raise, sent after the process publishes progress
through `P_PROGRESS` — a new SAB word a program advances *without* a syscall, because a process that
reported progress by syscall would be inside one when the signal arrived.

### Also landed

Items (a)–(f) from the preamble: the monotonic `caps` bitmask; `sid`, the leader link and `setsid`,
with SIGHUP/SIGTTIN/SIGTTOU explicitly **not** claimed until M4; `waitpid` distinguishing
STAT_EXITED from STAT_KILLED; two-phase teardown answering every outstanding call before asserting
the count is zero; the per-fd in-flight budget with `ELIMIT`; and the ABI growth mechanism — SAB
magic and version asserted at libos init, reserved numbers, a `perform()` hatch, and a dispatch
table **derived** from `src/abi.mjs` at boot with an assertion that every declared call has a
handler. No generator and no build step.

`ELIMIT_ERRNO` and `TEARDOWN_ERRNO` are derived from the errno table rather than written as
indices. Both literals were correct; the first reader to re-check them by hand got them wrong,
because `ERRNO_NAMES` starts at ESUCCESS = 0 and has 77 entries. Deriving removes the thing that
has to be counted.

> **Four additions from `docs/research/09-hobbyist-os-actions.md`, all because the process-table
> layout is set here and reworking it later is the expensive version.** Sources are in that file;
> each is a dependency, not a preference.
>
> **(a) The capability bitmask goes in the table now, even though the narrowing call lands at M6.**
> Otherwise M6 reworks the table. The credential already carries `caps` with nothing reading it.
> SerenityOS's shape: a service acquires its handles, then drops the promise that would let it
> acquire more — kernel state, checked at dispatch, and **monotonic**. The asserted invariant is
> monotonicity, not a symptom: after narrowing, every widening must fail.
>
> **(b) `sid` goes in the table now**, because M4's line discipline hangs SIGTTIN, SIGTTOU and
> SIGHUP off the session. The ABI has `setpgid` and no session concept at all, so M4 would
> otherwise have to add a field to a live table.
>
> **M1 lands the field, the leader link and `setsid` — and explicitly does not claim SIGHUP,
> SIGTTIN or SIGTTOU work.** A session id is four bytes and free; a session that *works* is not:
> SIGHUP on leader death means the kernel has to know which pid leads, keep that link correct
> across teardown, and deliver to every process in every process group in the session — and
> constraint 18 requires that sweep be O(interested), not O(N). Recorded as a field plus an
> invariant rather than a feature, so M4 inherits something true instead of something that looks
> done. *(web-os-builder's caution, taken.)*
>
> **(c) `waitpid` must distinguish "exited with code N" from "killed for reason R".** With
> `Worker.terminate()` as the only kill and no exit path in the dying worker, **the kernel is the
> only thing that can record why** — so it is written at teardown or it is lost forever.
>
> **(d) Teardown is two-phase**: answer every outstanding call with a defined errno, then assert
> the count is zero. HelenOS's `EHANGUP` cleanup. Cheap here, and it is the only point where the
> outstanding-call count is still knowable.
>
> **(e) The per-process event backlog gets a bound and a defined overflow.** Promoted out of
> `PLAN.md` §9b on web-os-builder's argument, which corrected mine. I had filed it as "constraint
> 9's unnamed sibling". It is **strictly worse than constraint 9**: constraint 9's overflow is
> bounded by one 64 KiB SAB and visible at the call site, while this one grows without limit **on
> the kernel's own heap**, and the process that caused it is asleep in `Atomics.wait` and cannot
> drain. Constraint 17 caps processes at 128 precisely because the renderer dies between 3,200 and
> 4,800 workers; an unbounded per-process backlog reintroduces that same failure mode with no cap
> on it at all.
>
> HelenOS's answer is the cheap one and belongs in the **ABI contract** rather than the
> implementation: a fixed in-flight budget with a synchronous `ELIMIT` when it is exhausted. Which
> is why it lands here with the other table fields rather than at the milestone that first needs it.
>
> **The budget is charged per fd — not per process, and not per event source.** This is not a new
> concept; it falls out of constraint 42, which already made the fd the unit of *wakeability*:
> "`poll()` MUST be the single wait primitive over fds." If the fd is the unit a process waits on,
> it is the unit a budget must be charged against — otherwise the budget and the wait primitive
> disagree about what an event source is.
>
> Per *process* is wrong for the reason the OPFS finding was wrong: one chatty window consumes the
> whole budget and starves the same process's pipe events. That is head-of-line blocking across
> unrelated event classes, which is the same shape as one queue serving things with no reason to
> share a queue.
>
> Per *(process, source)* is wrong because "source" would be a second taxonomy beside the fd table,
> needing its own identity, lifetime and teardown. Per-fd gets all three free: the fd table already
> has them, `close(fd)` already releases the budget, and the two-phase teardown in (d) already walks
> the fds, so it drains the budgets in the same pass rather than needing a second sweep.
>
> It also gives the property the promotion was for: a process that floods one window's queue gets
> `ELIMIT` on **that fd** and keeps servicing its pipe. HelenOS's per-phone budget is consistent
> with this rather than against it — a phone is its connection handle, so it is the fd-equivalent
> once the handle types are lined up.
>
> **The invariant, stated so the next reader meets it: an event source that cannot be charged to an
> fd has no budget, and that is a design error rather than a special case.** True trivially at M1
> (no event sources yet — the budget is a field and an errno), still true at M4 (pipes and the pty
> are fds) and at M7 (`win_create` returns an fd). If a future event source is not an fd, the move
> is to make it an fd, not to add a second budget taxonomy.
>
> *(web-os-builder's answer to a question I left open rather than guessed at. I had offered
> per-process or per-(process, source); both were wrong, and constraint 42 already contained the
> answer. To be confirmed against the dispatch code at M1.)*
>
> **(f) The ABI needs a growth mechanism, and it is cheapest now.** AROS's ABI v1 break — a
> one-year estimate still producing forks a decade later — was *entirely* representation
> decisions: where a handle lives, what unit a pointer counts in, how state is partitioned. The
> analogues here are the SAB layout, the futex word's position, the `(lo, hi)` pairing and the
> `r0 < 0 && r1 == -1` convention. Three parts:
>
> - **A format magic and a version word in the SAB frame header.** Four bytes, impossible to
>   retrofit, and the harness is a second consumer of that format. Haiku reads four message
>   dialects through one dispatcher on exactly this.
> - **Retired call numbers stay reserved**, and one `perform(opcode, struct)` escape hatch exists.
>   Haiku added eight `BView` methods without touching the BeOS R5 vtable using reserved slots
>   plus one `Perform()`. The CALLID/NR split M0 already made is the class of change this makes
>   survivable.
> - **One declaration, derived at runtime — not generated.** `src/abi.mjs` is already that single
>   declaration, and a grep for duplicate SAB offsets or syscall numbers across `src`, `bench`,
>   `www` and `scripts` comes back clean. So the kernel dispatch table is **derived from it at
>   boot**, with an assertion that every declared call has a handler.
>
>   *An earlier version of this item asked for a generator emitting the stubs and the dispatch
>   table. That was wrong: a generator is a build step, and `CLAUDE.md` forbids one. It would also
>   be the project's first. The runtime-derived form gets the same single-source-of-truth property
>   with no build step and no generated file to drift — correction from web-os-builder.*
>
> One thing deliberately *not* added: the "not responding" detector. It depends on nothing in the
> window half — it is a kernel-side timer plus a UI hook — and with no preemption a wedged app is
> the normal case. But there is no UI to hook until M4a, so it lands there. Noted so it is not
> discovered at M9.

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

## M2a — A host-runnable kernel, before M2 · ✅ done · est 1 d, actual 0.5

**10,000 torn and bit-flipped journals: 0 crashes, 0 silent acceptances.** With the CRC check
removed, the same corpus yields **2,767** silent acceptances and the first one is case 0 — so the
clean run is evidence rather than an absence. `scripts/fsfuzz.py` is the gate; it runs in about
three seconds with no browser.

**Built, and these are M2's real codecs rather than test doubles:** `src/fs/crc32.mjs` (pinned to
the published CRC-32/ISO-HDLC check value 0xCBF43926, plus the empty-input case so a table that
happened to suit nine bytes is not mistaken for a correct one), `src/fs/journal.mjs` (record codec
and replay) and `src/fs/superblock.mjs`. `bench/fs-fuzz/hosttest.mjs` is 24 assertions under plain
Node: every refusal reason named, both tear shapes, and the superblock slot logic.

**The scope condition held and is now structural.** `src/fs/` is pure over byte arrays with all I/O
at the edges in `src/kernel/`, so the fuzz target costs nothing to keep. If a future codec reaches
for a sync access handle inside its parse path, `fsfuzz.py` stops running — which is the intended
alarm rather than a silent decay into a second implementation.

### What the codec does that a replay path usually gets wrong

- **The CRC covers the header, not just the payload.** A flipped length field is therefore caught.
  Covering only the payload would let a corrupt length through, and a length is the field a parser
  is most dangerous about trusting — it is checked against `MAX_PAYLOAD` before it is used for any
  arithmetic, and nothing is allocated on the strength of it.
- **A refusal is a named reason, never a bare false**: short header, bad magic, bad length, short
  payload, bad CRC, non-zero reserved. Replay reports *which* tear it found and how many bytes it
  discarded, because constraint 28 requires surfacing a bad image rather than reseeding.
- **Both tear shapes are tested separately**, since they take different branches: a tear inside a
  header cannot read a length at all, while one after it has a length that over-runs the buffer.
- **A sequence gap stops replay.** Records after a missing one are not later records; they are
  records whose predecessor is gone, and applying them would build state nobody wrote.
- **Three superblock slots, newest valid wins.** Against two alternating slots a bad write to the
  older one during a commit can leave zero valid copies (Phantom's argument). A corrupt newest slot
  falls back and *says so*; no valid slot is a refusal, not a reseed. The generation counter and the
  major/minor version are in the format now because neither can be added once it holds user data —
  a reader one step ahead refuses rather than guesses.

**Proof.** `scripts/fsfuzz.py` — host tests 24/24, fuzz 10,000 cases clean.
**Negative control, two of them.** `--no-crc` finds 2,767 silent acceptances, so the fuzzer can
fail. And the *gate* was shown to fail: with the CRC comparison deleted from the codec in a scratch
tree, `fsfuzz.py` exits 1 reporting 2 failed host tests and 547 silent acceptances — it catches a
defect in the code, not only its own switch.

**Residual, stated:** 64-bit fields are `BigInt` throughout, rendered as decimal strings only at the
JSON boundary. A u64 inode number silently losing precision as a double is the defect that would be
hardest to find later.

Ordering finding, not a preference: this is cheaper before M2 than after it.

The inode table, the superblock and journal codecs, path resolution and the dispatch table should
run in **plain Node** — no Worker, no SAB, no OPFS. SerenityOS builds its libraries a second time
for the host ("Lagom") precisely so unit tests and 81 fuzz targets run in milliseconds while the
OS target gets only UBSAN.

The reason it must precede M2: **journal replay is a parser over torn bytes, which is exactly a
fuzz target.** M2's negative control tests *one* hand-truncated journal. A fuzzer tests ten
thousand, and finds the tear that the one hand-written case does not.

Costs no dependency and no build step — the same `.mjs` files, imported by a script. This is why
`src/abi.mjs` holding only integers and pure codecs matters: it is importable from Node.

**Scope condition, and it is the whole value of the milestone: the host-runnable path must be the
same code, not a port.** The risk is M2's codecs reaching for OPFS or a SAB *inside* the parse path
and quietly becoming unfuzzable. So the inode table, the superblock codec and the journal codec stay
**pure over byte arrays, with all I/O at the edges**. Hold that and the fuzz target is free forever;
lose it and M2a decays into a maintained second implementation, which is the exact thing it exists
to avoid. *(web-os-builder's addition, from M0's experience with `src/abi.mjs`.)*

**Proof.** The journal codec round-trips under Node; a fuzz run over truncated and bit-flipped
journals terminates with no crash and no silent acceptance of a bad record.
**Negative control.** Remove the CRC check — the fuzzer must immediately find an accepted bad
record.

---

## M2 — VFS core on OPFS · ✅ done · est 8 d, actual 3

**All four proofs pass.** 10,000 files survive a reload with every byte and every mode bit intact
(`bytesOk 10000/10000`, `modesOk 10000/10000`); a journal torn three different ways reports the
discarded tail and never reseeds; two concurrent opens of one file both succeed, and across a
copy-on-write swing the holders keep reading the superseded generation while a later opener gets the
new one; and two writers on one inode both keep their committed bytes.

Suite: **4 checks, 167 expectations** (boot 30, syscall 31, m1 14, m2 92). `--prove-failure` 51–52 s,
stable. `scripts/fsfuzz.py`: 91/91 host tests, 10,000 torn journals accepting nothing, **42/42
failure-path assertions with a control that reinstates all 8 fixes and produces 23 failures**. Seven
of seven mutations caught. Six negative controls behave.

### The verification took eight rounds, and that is the record worth keeping

Rounds 1–5 each fixed a real defect correctly and none of them finished, because they were all
instances of one property:

| round | fix | why it was not enough |
|---|---|---|
| 1 | `writeFd` reads the inode's size, not the description's | `truncateFd` and `commit` read a stale one |
| 2 | gate on "has staged" rather than "is clean" | `copyUp`, `readFd`, `closeFd`, `O_TRUNC` still stale |
| 3 | descriptions cache **no** durable state | the staged generation's *base* was still a cached read |
| 4 | the commit validates its base `(gen, end)` | blind to an in-place write inside the slack |
| 5 | the stamp becomes a monotonic mutation counter | **the bump is not atomic with the mutation it stamps** |

**Round 6 found the actual cause: this kernel yields at every `await`, and nothing serialized
operations on one inode.** Every durable read-then-mutate spanning an await was a race, so each
correct fix exposed the next site. The signal was that the attacker's *complete* enumeration of
mutation sites still found the hazard — when an exhaustive search of the obvious shape keeps
finding new instances, the shape is wrong.

The fix is one async mutex per inode, held across the whole read-modify-write. It is verified
mechanically rather than argued: **all 81 awaits in `src/kernel/store.mjs` enumerated — 59 inside a
lock, 20 outside, none carrying a durable read-then-mutate across an await unlocked.** Deadlock
attempts failed. CAS exhaustion went from 13 of 200 to 0, because a re-stage now runs under the same
lock as the refusal. proof (a) got marginally *faster*, and the volume lock priced out as noise
(4129 ms locked against 4552 unlocked).

The deadlock rule is **enforced, not documented**: `scripts/fsfuzz.py` lints the ten declared lock
takers and refuses a `withInode` call outside them or a taker called from inside the module, with
its own control, shown catching a taker that stops taking.

**Rounds 7–8 were a different class entirely** — POSIX semantics and swallowed errors, neither
needing concurrency:

- **`O_APPEND` was a seek at open, not an append per write.** Two appenders, four calls, every call
  returning success, four acknowledged bytes gone, fsck clean. A shell's `>>` would have hit it at M5.
- **An errno collapsed into a benign value, twice.** `IO_LIST` failing became `[]`, which `fsck`
  read as "listed, and empty". Then the same bug for `IO_READ_ALL`: an unreadable superblock slot
  read as *absent*, so a populated volume mounted as a first boot and **reseeded** — constraint 28's
  named defect, reached through an error path. Measured before the fix: a 1-inode tree published
  over a 28-inode volume with 10 blobs still on disk.
- **`later()` discarded its rejection reason**, so any kernel-side exception in any async syscall
  body became an anonymous `-EIO`. It is counted and named now, and the suite asserts the count is
  zero — with an anti-vacuity partner asserting the counters were actually read, because a
  page-wide zero that nobody summed is a number no clause can defend.

### The two decisions the spec required here

**Copy-on-write, not metadata-only durability** (constraint 60, `DECISIONS.md` D17). The rejected
answer is ext4's `data=writeback`, which is not ext4's default precisely because it leaves intact
metadata pointing at torn data. COW is nearly free here because a blob is named `ino.gen`, so the
swing is a reference change. The append exception — a write at or beyond the committed size goes in
place, because the committed size does not name those bytes — is what keeps a sequential appender
from copying its whole file per `fsync`; 10,000 files cost **0 copy-ups**.

**The superblock format** was settled by M2a and used unchanged: generation, major/minor, three
slots, newest-valid-wins. Three because against two alternating slots a bad write to the *older*
one during a commit can leave zero valid copies.

### What is on the record rather than fixed

Eleven numbered limitations, constraints 61–71, each with an address and a reproduction, sorted into
defect / permitted-by-decision / structural. The spec warns that discovering a data-consistency
property after a user has files is the bad outcome; a recorded limitation with an address is not
that, and an unrecorded one is.

**Build.** Days 1–4: port `../webxp/shared/fs/vfs.mjs` (1,301 lines) — `#lookup` with
`MAX_LINKS=40`, the permission checks, the error codes, `serialize`/`parse` as snapshot writer and
half of fsck. Two changes touch nearly every method: data becomes bytes, and the credential becomes
a per-call argument (29).

Days 5–8: the inode→`{handle, refcount}` table (47); boot-lock retry ~3 s with backoff (48);
`fsync` separate, journal flushed on fsync/snapshot/idle (23); fsck never reseeds (28). Write
ordering: blob → flush → journal → flush → apply in memory.

**Decide the data-consistency question in days 5-8.** File data is **not journalled — only
metadata is.** Blobs live flat in OPFS named by inode (26), so overwriting an existing file
mutates its blob *in place*. The journal and the alternating superblocks give consistency for
metadata; a blob half-overwritten when the tab dies leaves **intact metadata pointing at torn
data**. M2's ordering protects *new* data and does not make an overwrite atomic.

That is POSIX-permissible without `fsync`, and it is exactly ext4's `data=writeback` — which is
not ext4's default, precisely to avoid it. Phantom, the only shipped orthogonally-persistent OS,
gives every page three blocks under the rule "if a page is to be written, it goes to curr ONLY".

Two acceptable answers, and the choice must be made here rather than discovered later:
1. **Copy-on-write the blob** — write a new one, swing the reference at commit. Cheap, because the
   name is just an integer.
2. **Declare the guarantee metadata-only**, in `docs/CONSTRAINTS.md` and wherever a reader meets
   it.

Discovering this after a user has files is the bad outcome. `docs/research/09-hobbyist-os-actions.md` §5.

**Also decide the superblock's version field here**, because it is unavailable later: a generation
counter plus major/minor, with "minor newer than me ⇒ refuse". Phantom holds three superblock
copies, not two — against two alternating slots, a bad write to the older slot *during* a commit
can leave zero valid copies. With three, constraint 28's "mounts read-only and reports" can become
"mounts the previous generation read-write and reports" for the same honesty.

**Proof.** (a) 10k files, reload, every byte and every mode bit intact; (b) truncate the journal
mid-record — fsck reports the discarded tail rather than reseeding; (c) two concurrent opens of one
file both succeed.

**Negative control, two stages.** Drop the data-before-metadata ordering — fsck must report
corruption. Then break the CRC check and confirm the torn-journal test *starts passing*; if it
passes either way it was testing nothing.

---

## M3 — `/proc`, `/dev`, mounts · ✅ done · est 4 d, actual 1 · **ACCEPT**

**Verdict: ACCEPT.** All five build items are done and verified. All three proofs pass, each of the
three negative controls moves a named subset of expectations and nothing else, and the nine findings
an adversarial review returned are fixed with a check per fixed defect.

```
scripts/check.py                      5 checks, 222 expectations (m3: 55)
scripts/check.py --prove-failure      exit 0 — all 217 invert and fire
scripts/check.py --negative proc-cache   m3 fail: 3 red, 47 intact
scripts/check.py --negative usr-404      m3 fail: 4 red, 46 intact
scripts/check.py --negative trace-tiny   m3 fail: 4 red, 46 intact
bench/m3-synth/probe.mjs              84 host assertions (/proc, /dev, no browser)
bench/m3-provider/probe.mjs           70 host assertions (the table, SSRF, /usr)
bench/m3-trace/probe.mjs              40 host assertions + the record cost
bench/m3-tmpfs/probe.mjs              61 host assertions (/tmp, no browser)
scripts/fsfuzz.py                     129 fs host tests (was 91), src/fs/ still pure
```

The headline page run is **3.3 s** for twelve sections. Every assertion is taken from inside a process
worker through real syscalls: reading the generators on the kernel's own thread would prove they
work and nothing about whether a process can reach them, which is the whole of what this milestone
builds.

### What was built

**The mount table** is `src/fs/mounts.mjs`, pure and in `src/fs/` for that reason — resolution is a
total function over a path and a table, so `fsfuzz.py` drives it without a browser. Longest prefix
is taken on **component boundaries, never on the string**: a string match puts `/usrlocal` inside
the `/usr` mount, which reads fine and writes to the wrong volume. Mutating `resolve` to a
string-prefix match fails exactly the four host labels naming `/usrlocal` and `/usrx`.

Device numbers start at 1, which is load-bearing: `encodeFilestat` writes `st.dev || 0`, so a zero
device and a filesystem that never set one would be the same bytes. `FST_DEV` stops being a literal
zero, and that is what makes the table observable from userland — `stat` on `/`, `/proc` and
`/dev/trace` reports three distinct devices.

**Resolution happens once, at the kernel edge.** The cwd join and then the mount lookup, in that
order, in `resolveMount` — asking which filesystem owns `../x` has no answer. The twelve path
syscalls keep one renderer each through `metaOp` and `metaRead`, and a read-only mount refuses in
one place. The two-path calls (`rename`, `link`) require both ends on one mount and answer EXDEV
otherwise, which is POSIX's own answer and what `mv` expects.

**`/proc` and `/dev` are one adapter**, `src/kernel/synth.mjs`, so each filesystem is a pair of pure
functions over a relative path rather than fourteen VFS methods. Adding a generated file is a row in
a table. A generated file is `F_SYNTH` — a row in the existing `KIND_OPS` table — so `read(2)` is
the same call for `/proc/<pid>/status` as for a real file, and answers with no round trip.

**The provider table** is data: `{id, template, range, maxObject, auth}`. `/usr` is its first
consumer. A process cannot reach it at all — there is no `SYS_mount` — and `urlFor` is the only
place a request URL is built, from a committed template whose origin is a literal. Path validation
is a **closed list** rather than escaping, because escaping answers "can I make this safe" and this
answers "is this a filesystem path": scheme, authority, percent-encoding, dotdot, NUL, query and
fragment each refused by name. Reducing it to a dotdot substring check lets through 15 of the 17
refusals, including the cloud metadata endpoint and a localhost admin port.

**The trace ring** writes two records per syscall and reads no clock — see the corrections below.
`dropped` is derived from how far the ring has been lapped, not accumulated, so there is no counter
to forget to increment and no way for it to disagree with the ring's contents.

### The three proofs, and what each control moved

| | Proof | Control | Moves |
| --- | --- | --- | --- |
| 1 | `ls /proc` enumerates live pids; a killed one's directory vanishes | `proc-cache` serves a cached listing | 3 labels — the listing ones. `stat` and `open` stay live and their refusals HOLD, which says which of the two routes the proof tested |
| 2 | a ranged GET returns exactly the requested bytes with `Content-Range` | `usr-404` points the manifest at a missing object | 4 labels. The MOUNT fails and records why; the probe itself still passes, because a missing object does not remove the provider's `Range` support |
| 3 | `/dev/trace` replays a known syscall sequence, counter visible | `trace-tiny` builds the ring at 64 KiB | 4 labels. `dropped` goes to 6,315 and `undersized` to true, while **"the counter is displayed" HOLDS** — that split is the whole control |

Proof 1 asserts **two transitions, not one**, because POSIX has two: a killed-but-unreaped process
is a ZOMBIE and still has a `/proc` entry, and the entry goes when the slot is freed. This kernel
frees it after the ~2.2 s terminate quarantine, so the wait is a bounded, paced poll on the real
listing — 40 × 150 ms — and not a sleep, which would pass for a `/proc` that had never listed the
pid at all.

### What the proofs caught, and the corrections on the record

Four defects, three of them found by the checks rather than by reading.

1. **The kernel spread a program's data over its own stamped fields**, so a program returning a
   field called `pid` relabelled its result row: a `go` dispatched to pid 1 came back as pid 2 and
   the page could not find its row. The dispatch log said `to=1` while the result said `pid: 2`.
   Beyond the confusion it is a forgery surface. Constraint 75.
2. **`truncate` was missed when the path calls moved onto the mount table.** It resolves its own
   path, so `truncate("/proc/1/status")` answered ENOENT about a file the caller had just read.
   Caught only because the read-only proof asserts **every mutation's errno separately** — a single
   "it refused" would have passed.
3. **A `stat` of `/dev/trace` consumed trace records**, because size and content each re-ran the
   generator. The ring's reader cursor was the cause and is gone. Constraint 74.
4. **`statfs` ignored the path the ABI gives it**, so `statfs("/proc")` would have reported the OPFS
   volume's numbers. The path is now optional — absent means the root mount — which keeps every
   existing caller working.

Two measurements corrected a figure in this file: the trace record is **19.4 ns, not 4 ns**
(constraint 72), and a volatile generated file **publishes no size** because a published one is
already stale (constraint 74).

Two harness defects my own changes exposed, both fixed in the harness rather than worked around:
the served-witness treated a **206 as a file the tree does not serve**, which turned every `/usr`
mount into 14 witness failures; and the dead-allowance note was computed **per serving**, so a 404
only one root serves was reported as deletable while the same run forgave its console error two
lines later.

### `/tmp` reuses the VFS

A tmpfs needs the whole POSIX surface the VFS already implements over an in-memory inode table, so
`src/kernel/tmpfs.mjs` is a `VFS` instance plus a `Map` from inode to bytes, and `F_TMP` is a
writable synchronous description kind. Writing a second filesystem would have been two renderers of
one fact and the second would be the one with the permission bug. It is bounded at 64 MiB for the
same reason the process table is capped: one process must not be able to exhaust the renderer's heap
and take every other process with it.

### What the review found

The change went to an independent critic with the artifact and the acceptance criteria and not the
conclusion, as the method above prescribes. It returned **nine findings and a prose error; all ten
verified against the code and all are fixed.** Three were reachable from an unprivileged process and
faulted the kernel worker, which is the class M3 was least likely to find by reading:

| | Finding |
| --- | --- |
| HIGH | `/dev/<any Object.prototype key>` was a readable phantom file. `/dev/constructor` put an object where bytes were expected, and `read(2)` on it threw a TypeError out of a handler the dispatcher does not wrap — **two syscalls to fault the kernel**. `procfs` and `providers` already guarded their table lookups; `devfs` was the one that did not |
| HIGH | `seek(SEEK_END)` on a `/tmp` **directory** fd asked a directory for its byte length and threw. Now EISDIR |
| HIGH | `O_APPEND` on a tmpfs resolved its offset **once at open** — the exact defect `calls.mjs` already documents for the OPFS path, where it was measured losing a writer's four bytes. The offset is now resolved per write |
| MEDIUM | the read-only test moved from the live volume to a **boot-time mount flag**, so after `store.mjs` demotes the volume at runtime (constraint 28) a `mkdir` mutated the in-memory tree and *then* returned EROFS. The durable mount asks the store now |
| MEDIUM | `..` was stripped **lexically** at the kernel edge, so a `..` through a nonexistent or non-directory component stopped failing and one through a symlink resolved against the name. The root mount gets the path with `..` intact |
| MEDIUM | `unlink` on an open `/tmp` file freed its bytes while a description still held it, and the comment asserted that state was unreachable. It is reachable in three syscalls; ESTALE now, matching the OPFS volume |
| LOW ×3 | `TR_TIME`'s comment claimed a cross-agent clock the value does not have; a comment described a `pwrite` refusal the ops table does not make while calling the real guard redundant; `statfs` discarded the filesystem's own `bsize` and `namemax` |

Every one of the first six is now a row in `bench/m3-fs/program.mjs`'s `regress` mode, taken through
real syscalls — none of the ten original sections reached any of them.

**The lesson worth keeping:** the two findings that mattered most were both *a comment asserting an
invariant the code did not have*. A confident comment is not evidence, and the critic read the code
instead.

### What is not done

There is no `chdir`, so every cwd is `/` — constraint 81. `/usr` costs its whole size in memory and
the mount is atomic, which is what makes control 2 possible and is not a design for a large volume —
constraint 78. A symlink cannot cross a mount (77) and a `..` that lands in another mount is lexical
(84), which are one gap in two guises: the walk does not consult the mount table. **The mountpoints
have no backing directory, so `ls /` does not list them (85)** — a defect, with the fix named.

`mount` never accepts a caller-supplied URL, and the narrowest form of that rule is what shipped: a
process cannot mount at all.

---

## M4 — Pipes and process groups · ✅ done · est 5 d, actual 1 · **ACCEPT**

**Verdict: ACCEPT.** All four of the milestone's stated proofs pass, the negative control moves
exactly the expectations that depend on it, and the prerequisite experiment is retired. The pty,
the line discipline and `poll` are **M4b**, recorded below.

```
scripts/check.py                       6 checks, 245 expectations (m4: 23)
scripts/check.py --prove-failure       exit 0 — all 243 invert and fire
scripts/check.py --negative no-sigpipe-signal   m4 fail: 5 red, 18 intact
bench/m4-pipe/probe.mjs                79 host assertions (the Pipe, no browser)
bench/m4-intr/probe.py                 the prerequisite experiment, retired
```

The page run is **1.1 s** over five fresh kernels — one per proof, because each spawns and kills
several processes and leaves zombies in a ~2.2 s quarantine, so sharing a kernel would make every
proof depend on how fast the last one finished.

### The four proofs

The milestone states them in shell syntax and there is no shell until M5, so each is built from
the mechanism the shell will use: `pipe2` + `spawn` with posix_spawn file actions + `setpgid`,
which is what replaces `fork` (constraint 20). An orchestrator process spawns its own stages, so
every byte and every signal crosses a real syscall from inside a real process worker.

| | Proof | Result |
| --- | --- | --- |
| 1 | `yes \| head -1` terminates | the writer is **killed by SIGPIPE** (signal 13), the reader exits 0 |
| 2 | Ctrl-C on a pipeline kills both | both stages **killed by SIGINT** (signal 2) |
| 3 | a writer killed `-9` makes its blocked reader return 0 (EOF) | the reader **exits cleanly**; EOF is 0 and not an errno |
| 4 | a blocked writer whose reader died gets `-EPIPE` plus SIGPIPE | the writer is **killed by SIGPIPE** |

**The control** (`--negative no-sigpipe-signal`) stops SIGPIPE being fatal and moves proofs 1 and 4
and nothing else. That split is what makes it specific: EOF is the *other* half of `docs/ABI.md`
decision 5 and has nothing to do with SIGPIPE, so a control that moved proof 3 too would mean the
two directions were sharing an implementation. The writer's runaway loop is capped and reports
`hitCap` rather than hanging, because a real hang gives the harness a timeout and no information.

### What the review changed

The change went to an independent critic. It returned **twelve findings; all twelve verified
against the code and all are fixed.** Three would have corrupted the kernel's own accounting, and
**four meant proofs that passed were not testing what they claimed** — which is the more
uncomfortable half.

| | Finding |
| --- | --- |
| 97 | `detachChild` ran before `scheduleFree`, whose timer keyed its free on the entry just removed — so a process slot was **never reclaimed**, and after `PROC_CAP` such children every `spawn` fails forever |
| 98 | a fatal SIGPIPE had already answered the call, and the pipe answered it **again** — two replies for one call, so `G_INFLIGHT` drifted negative and the issued == replied identity broke |
| 99 | `getpgid` **ignored its argument** and returned the caller's group |
| 100 | no fd ceiling, so a `dup2` to fd 2^30 grew the fd array to a billion entries that two kernel-thread loops then walked — one process wedging the kernel |
| 101 | a faulting process became a ZOMBIE **without teardown**, so it kept its fds open and its pipeline peer parked on an EOF that could never arrive |
| 102 | an interrupted `spawn` left an **orphan child** running, and the comment claimed a reap that did not exist |

**The four proofs that were not testing their subject**, all in the harness rather than the kernel:

- the "sleeper" stage slept **0 ns** — `clock_nanosleep` was passed `(0, 0)` — so it exited on its
  own and the two proofs that kill it were racing worker startup.
- proof 2 sent **two separate `kill(pid)` calls**, not `kill(-pgid)`. `deliverSignal`'s
  `target < 0` branch and the pgid inheritance this milestone added were untested, while the
  check's own note claimed "the SIGINT sweep over a process group". It now puts the stages in their
  own group, verifies the group by reading it back, and sends ONE negative-pid kill — and finding
  99 is what that assertion caught.
- both kill proofs signalled stages that were still `SPAWNING`. They now wait until the stage has
  issued a syscall, **observed through `/proc/<pid>/status`** rather than slept for.
- the control's documented hang never happened: `yes` broke on the first `-EPIPE`, so `hitCap` was
  dead instrumentation. `yes` now ignores the error, which is both the documented failure mode and
  the naive program every pipeline actually contains.

**And the probe could not see findings 98 at all**, because its fake `raise` did not reap — 68
assertions passed over a double-reply bug. A test double that is gentler than the real thing tests
a world that does not exist (constraint 98).

### Six defects in the code this built on

Four were in mechanisms that had **never run**. That is the finding worth keeping: `ppid` was
assigned nowhere, so `waitpid`, `parkParent` and teardown's parent-wake were all unreachable, and
the moment they became reachable two of them were wrong.

| | Defect |
| --- | --- |
| 90 | `spawn` assigned `ppid` nowhere; nothing inherited `pgid` or `sid`, so `kill(-pgid)` could not reach a pipeline |
| 91 | teardown's parent-wake replied **without detaching the child**, so a parent waiting on two children was answered with the first one's pid twice |
| 92 | a pipe's open-end counts were raised per HOLDER and dropped per DESCRIPTION, so a pipeline left `writers` at 1 after its only writer exited and the reader parked on an EOF that could never arrive |
| 93 | the pipe descriptions carried their **creator's** slot, so a child's read parked a record against its parent and replied to the parent |
| 94 | `pipe2` can return **fd 0** as the read end, because `spawn` leaves fd 0 free — a stage dup'd fd 0 onto fd 0 and then closed it as "the pipe fd" |
| 96 | `null` from an ops row means "parked", and `null >= 0` is true — a parked read left to fall through answered the caller 0, which on a pipe means EOF |

**92 and 93 both presented as a pipeline that simply stopped**, with no error anywhere, because a
parked reader and a parked writer are each a legitimate state. What located them was making the
page's timeout carry the kernel's park and refcount dump: one run then read
`readers: 2, writers: 1` for one reader and a dead writer, and the cause was arithmetic.

---

## M4b — the pty, the line discipline, `poll` · ✅ done · est 2 d, actual 1 · **ACCEPT**

```
scripts/check.py                     7 checks, 299 expectations (m4b: 54) — 7/7, exit 0
scripts/check.py --prove-failure both  exit 0 — every expectation inverts and fires
bench/kernel-churn/probe.py          900 kernel boots; --stall proves the fetch deadline
scripts/check.py --negative no-isig           m4b fail: 8 red, 45 intact
scripts/check.py --negative no-poll-wake      m4b fail: 3 red, 50 intact
scripts/check.py --negative no-finish-guard   m4b fail: 4 red, 49 intact
scripts/check.py --negative no-winch          m4b fail: 6 red, 47 intact
bench/m4b-pty/probe.mjs              124 host assertions (the discipline, no browser)
bench/m4b-pty/controls.py            5 controls, each scored on which labels move
scripts/fsfuzz.py                    129 host tests, 10k torn journals, no browser
```

**The flake that was open here is root-caused, and it found a real defect.** This check reported
BROKEN about 1 run in 12 on a page-level `timed out waiting for spawned`, and it is the only check
that boots one kernel per proof — thirteen per run against every other check's one.

`bench/kernel-churn/probe.py` boots N kernels and does nothing else: no pty, no pipes, no signals,
one trivial process each. It reproduces the identical stall at the identical step — **0 stalls in
360 boots idle, 3 in 540 under threefold contention, 0.56% per boot**. At that rate a
thirteen-kernel page fails about 1 run in 14, against the 1 in 12 observed. The arithmetic closing
is why this explanation is believed where five earlier ones were not.

THE DEFECT: `programImage` awaited `fetch` with no timeout, and the caller cannot be answered
until that load resolves — so a stalled program fetch made `spawn` HANG rather than fail, with no
errno and nothing in the trace. **M5 narrowed what this covers and the bound still holds:** `SYS_spawn` no longer fetches at all — `src/kernel/exec.mjs` reads a program through the mount table (constraint 123) — so a process cannot hang this way, and what `programImage` still serves is the page's own `t: "spawn"`, the supervisor path every bench page boots through and where the stall was measured. Bounded now at 5 s through `AbortController`, retried once
(constraint 155, `docs/DECISIONS.md` D21), and demonstrated both ways by
`bench/kernel-churn/probe.py --stall`. The residual `up` stall is Chrome's worker startup under
load, it is not ours, and it fails closed — a run the harness could not measure, never a pass.

Thirteen sections over thirteen fresh kernels, **3.5–6.0 s** across the runs that measured it. Every byte and every signal crosses a real
syscall from inside a real process worker.

The expectation count went 33 → 53 and the host assertions 94 → 124 **after** the milestone was
first called done, which is the adversarial review below. Four of the original clauses were
passing without asserting their subject, and four of the review's own fixes had no check until
they were given one — a fixed bug becomes a check, including when the bug was found by reading.

### What the documents specify, and what they do not

`MILESTONES.md` M4 specifies **exactly one** behaviour of the discipline: ISIG with VINTR must
raise SIGINT on the foreground group *"even when the UI is wedged"*. That is the `wedged_intr`
section, proved against a stage spinning in a compute loop and issuing a syscall only every 20,000
iterations.

**`ICANON` and `ECHO` semantics are specified in no authored document** (constraint 106). Line
buffering, ERASE, KILL, VEOF, the CR LF echo and the destructive backspace-space-backspace are
POSIX's defaults taken as an assumption, and `src/kernel/pty.mjs` says so where they are
implemented rather than presenting them as design. `docs/ABI.md` also requires `VMIN` and `VTIME`
in the struct; they are carried and **nothing reads them**, which is stated at the declaration.

### `poll` is here because a constraint required it, not because the build list did

Constraint 42 is normative — "`poll()` MUST be the single wait primitive over fds" — and M4's build
list omits it. A process has one futex word and one outstanding call, so one terminal plus a pipe
cannot otherwise wake it. The case that hits it first is `docs/designs/REVIEW-FINDINGS.md`
finding 1's **corrected** scenario: parked in `read(master)` at idle with no output, keys dead
indefinitely. That is M4a's terminal, not M7's window.

Both halves are proved. `poll_ready` shows it reporting readiness and answering POLLNVAL for a
closed fd; `poll_wait` shows a process **parked** over a pipe and a terminal, woken by the one that
became ready — and the stage reports what it saw down the pty and its verdict in its exit code, so
the assertion is on what it observed rather than on its having finished.

### The adversarial review, and the thirteen findings it returned

A critic was given `src/kernel/pty.mjs`, `src/kernel/calls.mjs` and the milestone's acceptance
criteria, and not the author's account of them (`~/.claude/rules/adversarial-review.md`). Every
finding was reproduced against the code before being acted on. **Three of them were live defects
that 94 passing assertions did not notice**, and each failed by STOPPING rather than by erring:

| | what broke | how it presented |
|---|---|---|
| F1 | an over-long canonical line discarded its own terminating newline | the terminal wedged permanently; the reader parked with no error |
| F2 | a `^D` typed before the reader arrived was dropped | a program computing when the key was pressed parked forever |
| F8 | slave output past the 16 KiB ring returned a 0 count and nothing parked | output lost with no errno; POLLOUT was unconditional, so a poll-then-write loop span |

Measured before the fix, under Node: `F1 read: null linePending 4096 linesReady 0`,
`F2 read after unparked ^D: null`, `F8 first writeOutput: 16384 second: 0`.

**F3 was the one with teeth.** A pty operation signals the foreground group, and a fresh pty's
foreground group is its OPENER's — so a resize issued before a shell has moved it raises SIGWINCH
on the process making the call, which interrupts that call and then replied to the handler's return
as well. Two replies for one call. Nine of the ten existing sections could not reach it because
`withStage` moves the group to a child first, which is what a shell does per pipeline. The guard
is in `finish`, the funnel all three dispatchers and `later` return through (constraint 114), and
the `self_signal` section is the proof. The drop is counted rather than silent.

The rest were a leaked reference and a leaked OPFS sync handle on `-EMFILE` (constraint 113), a
teardown sweep that changed readiness without waking parked polls (115), a `poll` timeout that
republished a stale scan, `poll(NULL, 0, -1)` answering immediately instead of blocking (116), a
dead `peekLast` and a docstring describing the wrong method.

Four of those had no check, because they were found by reading rather than by failing. They have
one now — `fd_limit`, `open_leak`, `teardown_wake` and `empty_poll`, each demonstrated by putting
its own defect back. Two needed care about HOW they fail: a leaked description reference leaves a
reader with no EOF, so the fd proof asks through `poll` with a deadline rather than through `read`,
which would park forever and end the check as BROKEN with no expectations. Where an infinite park
is the only way to assert the subject at all — teardown's wake, which a finite timeout's own
rescan would answer — the orchestrator owns the deadline and reports `wokenByTeardown: false`
(constraint 122).

### Four checks that were passing without asserting their subject

Worth more than the defects, because they were the reason the defects survived:

- **The SIGWINCH clause could not fail.** It read the stage's `exited` flag, which is equally true
  of a sleep that ran its full 8 seconds and returned 0. The stage now exits 0 only when its own
  `clock_nanosleep` returned `-EINTR`, and `--negative no-winch` is what shows the clause moving.
- **Two "parked" clauses asserted only that a process had not exited**, because
  `/proc/<pid>/status`'s `state` is `running` for everything that is not a zombie — and they
  sampled it immediately after the write meant to park it, so they raced it too. `status` now
  publishes the syscall number, and the checks WAIT for a call outstanding in the named call
  (constraint 117).
- **Two clauses were `None == None`** — a measured errno against the constant it should equal, both
  travelling in the same evidence object, so one typo would have taken both halves out together
  and left the clause green (constraint 120).
- **`Pty.writable` had no caller in the kernel.** It answered POLLOUT correctly from the day it was
  written while `pollOne` still carried an unconditional `revents |= POLLOUT`. A unit probe calling
  it directly passed; the one caller that mattered had not been changed (constraint 119).

And a flake, found by running the headline check five times rather than once: the spinning stage
hit its 200,000-iteration cap and exited normally before the orchestrator's keystroke arrived,
about 1 run in 4. The ceiling is wall clock now, and returning at all is the failure
(constraint 118).

### The defect this found, and why it had no symptom before

**Constraint 103.** Teardown decremented an fd refcount once per DESCRIPTION, not per fd — it
deduplicated, on the reasoning that a dup'd description should close once, which the refcount
already guarantees. So a process holding one description on two fds leaked a reference forever.

Harmless until now: the only shared description was the sink, whose close is a no-op. A terminal
stage holds the pty slave on **fd 0 and fd 1**, so the slave end never closed, `slaves` never
reached 0, and the master's reader parked on an EOF that could never arrive. **No error anywhere** —
the symptom was a process stuck in `read`, and what located it was the page attaching the kernel's
park dump to its own timeout.

### The controls

| | Control | Moves |
| --- | --- | --- |
| `no-isig` | every pty comes up with ISIG cleared | 8 labels: both Ctrl-C sections, the echoed-byte clause, and the "a fresh pty is signal-generating" clause — the control changes the DEFAULT termios, so that is its own mechanism rather than collateral. Echo, canonical buffering, both poll sections and the pgrp moves hold |
| `no-poll-wake` | parked polls are never re-evaluated | 3 labels: the blocking-poll section alone. Synchronous readiness reporting does not go through the wake, and a control that moved both would not say which half it removed |

**The harness refused `no-isig` until its eighth label was declared.** With ISIG off the `^C` is
data, so it is echoed like any other byte — measured as `echo: '\x03'`. Scoring a control on
*which* labels move is what forced the full consequence to be stated.

### One ring, not four

`src/fs/ring.mjs` was extracted from the pipe before the pty grew three more queues (constraint
112). A push that straddles the end of the buffer is two copies, and the second is the one a
hand-written ring forgets. Pure, so `fsfuzz.py` lints it, and the pipe's 79 assertions are what
showed the extraction was faithful.

---

## M4a — The terminal gets a real window · done · 1 day · ~1,250 LoC

**ACCEPT.** A real browser keypress reaches a shell on a real pty and the PTY's echo puts the
character on the screen. 26 expectations in 6.38 s over two fresh kernels.

**Built.** `src/kernel/wins.mjs`'s ancestor was `/dev/console`: one host-backed device, a keystroke queue
one way and a post to the page the other, with a row in `src/kernel/files.mjs`'s ops table
(`F_WIN`, the kind the ABI reserved by name) and a row in `pollOne`. `src/bin/term.mjs` is the
terminal emulator AS A PROCESS — it opens the console, opens a pty, spawns `/usr/bin/sh` on the
slave in its own foreground group, and polls BOTH sources. `src/wm/window.mjs` is
`../webxp/src/window.mjs` ported unstyled: the two-box geometry, the clamp, the pointer drag and
the keyboard equivalent of it. `src/wm/terminal.mjs` is the widget, and **it draws nothing on a
keypress**. `www/m4a.html` wires the four together.

**The special case, and its expiry.** One console, created by the kernel when the page attaches a
window, with `open("/dev/console")` as its only producer. Said in that device's
header, in `src/bin/term.mjs`'s, and in `docs/DECISIONS.md` D25. What M7 keeps is the ONE decision
underneath it: **a window is a file description, so `poll` is the single wait primitive** — the ops
row and the poll row survive `win_create` unchanged. Everything else goes.

**`poll` was built in M4b for this milestone and this is the bill.**
`docs/designs/REVIEW-FINDINGS.md` finding 1's *corrected* scenario is the one M4a walks into:
parked in `read(master)` at idle with nothing flowing, the keys are dead indefinitely. Asserted
from the kernel's own park state and not from the keystroke having worked — `inflight: "poll"`,
holding fd 3 kind 5 (`F_WIN`) and fd 4 kind 8 (`F_PTY_M`). Constraint 157.

**The not-responding detector landed here**, deferred from M1 for want of a UI to hook. It measures
the AGE OF THE OLDEST UNCOLLECTED KEYSTROKE, not syscall silence — a process in `sleep 60` is
silent and healthy. Caption at 1,000 ms, End Process at 5,000 ms (`docs/designs/fidelity-first.md`'s
thresholds), measured at 1,020 ms and 4,006 ms, cleared in 26 ms. Hysteresis is the DRAIN and not a
second time, and both edges are checked on the DOM caption. Constraint 163, decision D26.

**Two defects it found in code it built on.** `Enter` as carriage return types a line the shell
never receives: the discipline commits on byte 10 and implements no `ICRNL`, so the prompt accepted
typing and never answered (constraint 162). And `bench/m3-provider/probe.mjs`'s `implied
directories exist` had been RED since M5 — a literal `["include","lib"]` against a manifest that
grew eleven `bin/*` rows — unseen because the host probes are not in the registry (constraint 164).

**Proof.** `scripts/check.py --only m4a` — four sections: the echo (prompt, real keys, the window's
own delivery count, the echo, the shell running the line, Ctrl-C survived, Ctrl-D ending the
session), the park state, the frame's geometry at both clamped extremes, and the detector's two
edges. **THE KEYS ARE REAL:** the page announces `phase: await-keys` and stops; the check focuses
the terminal and presses them through `Input.dispatchKeyEvent`, so the widget receives `isTrusted`
events — `src/wm/terminal.mjs` counts trusted and synthesised keys separately and the check asserts
on the trusted count. Measured 11 real, 0 synthetic.

**Negative control.** `scripts/check.py --negative pty-detach` — a write to the pty master accepts
its bytes and DISCARDS them. 6 red, 20 intact. Every other link keeps working, so what disappears
is the echo and nothing else; `the window delivered the keystroke to the kernel` HOLDS at 11 of 11
bytes counted by the device. **That is the control's whole point:** a widget that echoed locally
would satisfy this milestone's proof with no pty behind it at all, and nothing else in the suite
can tell the two apart.

**One critic, then nine fixes.** M4a went build → independent attack → fix, as every milestone
here has. All nine findings were real and five were the SAME KIND of mistake: a guard present in
the code being ported, or in a sibling path, dropped by the new one — `term` discarding returns
`sh` checks, the chardev arm not undoing a count `pipe2` undoes, and two guards missing from the
ported clamp. The full record is constraints 166–174, each with the failure it produces. **The one
answered rather than fixed is 174:** teardown's `pollWake` is ungated, so `--negative
no-poll-wake` under-proves — pre-existing, and re-scoping another milestone's control is not a
window milestone's business.

**Gates.** `scripts/check.py --only m4a` (26 expectations, 6.4 s),
`scripts/check.py --negative pty-detach` (6 red, 20 intact),
`scripts/check.py --only m4a --negative no-isolation` (BROKEN: no SAB, so no kernel and no pty),
65 host checks over the console device, no browser — M7 retired that probe with the
device, and `bench/m7-win/probe.mjs` carries its two regressions forward —
`node bench/m4a-window/probe.mjs` (29 host checks over the clamp; two mutations move 10 and 2
labels and leave the rest) and
`node bench/m3-synth/probe.mjs` (98 host checks, 13 of them `/dev/console`'s in the mount table).

**Two defects the build found in ITSELF, by reading rather than by a failing proof, and both are
checks now.** `detach` cleared the keystroke queue and left the stale clock running, so a
DESTROYED window reported "(Not Responding)" — a caption on a frame that is gone. And `waitpid`
came after the loop unconditionally, so the CEILING path — the one that exists to report a session
that stopped — would have hung in the act of reporting it. The first is two labels in
that probe, shown capable of failing by removing the one line that fixes it; the
second is why `term` hangs up on its shell before waiting for it.

**Then the operator ran it in a real browser and found six more.** All six were in the HARNESS or
in a browser assumption, none was reachable from `scripts/check.py` as written, and the suite was
green at 26 expectations throughout. Constraints 175–180. The two that matter most:

- **`setPointerCapture` throws on an untrusted pointerId in Firefox and it was load-bearing**, so
  the title bar was dead to the mouse there while green here. A critic had raised that exact call
  and the author dismissed it because the label was green — a green check on one engine is not
  evidence about another (175).
- **The page left dead windows on screen.** Every proof terminated its own kernel and kept its
  frame, so the page finished showing terminals that took keystrokes and had nothing behind them —
  reported as "I am unable to type into the terminals". A dead terminal must not be
  indistinguishable from a working one, which is constraint 40 applied to the product. The page now
  ends by opening ONE live session, which is what this milestone exists for and had stopped doing
  (179).

The rest were a fixture that depended on the operator's window width (176), a fixture only one
driver could satisfy (177), a conjunction that could not name which clause failed (178), and a
timer that made the page look hung for a minute (180).

**Cost.** ~1,250 lines against the plan's ~200. The estimate assumed the window was the work. The
window is 240 lines; the device, the relay process, the widget, the detector and the check are the
other thousand — and three of those five are things `MILESTONES.md` and the handoff asked for in
the same breath as the window without counting them.

---

## M5 — The shell and ten programs · done · 1 day · ~3,600 LoC

**ACCEPT.** `ls /usr/bin | grep c | wc -l` answers 3 through three real processes, against a count
the check derives for itself by listing `/usr/bin` through syscalls; `/dev/trace` shows four
distinct pids doing it. Then `sleep 60 &`, `ps`, `kill %1`: the job is announced, `ps` lists the
sleeper by pid with `sleep 60` as its command from `/proc/<pid>/cmdline`, and the job dies of
SIGTERM. 34 expectations over nine fresh kernels in 38.1 s.

**Built.** `src/libos/shlex.mjs` carries the front end ported from
`../webxp/apps/terminal/shell.mjs` and `glob.mjs` — tokenize, parse, expand, glob, complete —
PURE, so `bench/m5-sh/probe.mjs` checks 91 properties of it under `node` in milliseconds.
`src/bin/sh.mjs` is a new executor: `pipe2` + `spawn` with posix_spawn file actions + `setpgid`,
redirections opened by the shell, background jobs with `%N` specs, and builtins for the commands
that cannot be programs (`cd`, `pwd`, `exit`, `jobs`, `wait`, `export`, `unset`, `complete`). Ten
programs in `/usr/bin`: `ls cat echo wc head grep sleep kill ps true`, plus `sh` — and `yes`, an
eleventh the review required: without an endless source, the no-hang property `cat`, `head`, `grep`
and `eachLine` are all written around had no spelling in this system (constraint 152). `src/libos/std.mjs`
is the program support library, handed over as `env.std` so a program imports nothing.

**What the milestone did not ask for and could not avoid.** `/usr/bin` meant `spawn` had to load a
program from the FILESYSTEM, and the call was loading it from the NETWORK: `new URL(path,
location)` ignores its base for a string carrying a scheme, so any process could name any origin
and have the kernel evaluate the reply as a program. `src/kernel/exec.mjs` is the fix and
constraint 123 is the record. `SYS_chdir` is 47, appended, because `cd` was not otherwise
expressible (constraint 128); `sigaction` and `nanosleep` gained libos stubs, the first of which
had had no caller anywhere since M1.

**Proof.** `scripts/check.py --only m5` — eight sections: the pipeline, job control, redirection,
the builtins, the exec path, the refusals, the shell on a real pty (a typed line echoed by the
discipline, Ctrl-C survived, Ctrl-D ending the session), and six URL spellings refused by the
mount table.
**Negative control.** `scripts/check.py --negative spawn-self` — `spawn` answers the caller's own
pid and creates nothing, for a caller that itself has a parent. 16 expectations red, 18 intact:
the builtins, the refusals and the URL refusals hold because none of them creates a process.

**What it cost elsewhere.** M4's and M4b's stage programs imported `"../../src/abi.mjs"`, which a
Blob image cannot resolve — every stage faulted with SIGABRT until the specifier became absolute
(constraint 125). The loader now refuses such a program by name rather than letting it fault.

**Two critics, then eleven fixes.** M5 went build → independent attack → fix → re-attack, as every
milestone here has. The two worst findings defeated M5's own central claim and are worth reading
before trusting any similar fix: the loader had MOVED the network hole rather than closing it (a
program's own `import "//host/x.mjs"` had the CHILD fetch and evaluate remote code while the
kernel's accounting stayed at zero loads, constraint 139), and a four-line program could panic the
whole kernel (constraint 140). The full record is constraints 139–152, each with the measurement
that produced it.

**Recorded limitations** are constraint 138, sorted into permitted-by-decision and structural; the
one thing left open is a dynamic `import(expr)` with a computed argument, which no scanner can
catch and which a Content-Security-Policy answers — M6 owns it (constraint 139).

**Gates.** `scripts/check.py --only m5` (38 expectations, 39 s),
`scripts/check.py --negative spawn-self` (18 red, 20 intact),
`node bench/m5-sh/probe.mjs` (111 host checks, no browser), and
`python3 bench/m5-exec/controls.py` (5 mutations of the loader, each scored on which labels move —
including a two-stage pair where collapsing the image cache key must move NOTHING and collapsing it
*plus* removing the byte comparison must move 17).

---

## M6 — Neuter the process realm · done · 0.5 days · ~1,500 LoC

Closed the hole that made everything above decorative. A process worker is same-origin, so it had
ambient OPFS access and could open the kernel's blob store by inode and write it — no credential
checked, no syscall made.

**It is two halves, and they are measurably disjoint.** That was the milestone's one surprise and
it changed the build.

- `src/libos/lockdown.mjs` strips the realm before program text is evaluated: `fetch`,
  `XMLHttpRequest`, `importScripts`, `indexedDB`, `caches`, `WebSocket`, `Worker`, `SharedWorker`,
  `navigator.storage`, `URL.createObjectURL` and `revokeObjectURL` (41, 53). Eleven rows as DATA,
  each naming what it reaches, removed by walking the prototype chain — `delete self.fetch` removes
  nothing, because nothing here is an own property.
- `scripts/serve.py` sends a Content-Security-Policy over `src/libos/`:
  `default-src 'none'; script-src 'self' blob:; connect-src 'none'`. That is
  constraint 139's open half — a computed `import(expr)` is the module loader, not `fetch`, so no
  scanner over program text and no deletion can reach it.

**`WHERE` THE POLICY GOES WAS MEASURED, AND 139 HAD IT WRONG.** 139 says "a Content-Security-Policy
on the document is the answer". The policy is the answer; the document is not the place — on a
dedicated module worker's loader a document policy changes NOTHING, measured across four
deliveries with zero violations reported (`bench/m6-realm/csp-probe.py`, constraint 187; the
correction is 188). It goes on the response that creates the realm.

**Proof,** `scripts/check.py --only m6` — 31 expectations, 1.1 s, `www/m6.html`:

- **the volume, which is the headline.** uid 0 writes a 0600 file and closes it; a uid-1000
  process is told EACCES by the syscall channel, then opens the kernel's blob BY INODE through
  ambient OPFS and writes it; a third process, uid 0, reads the file back through the syscall
  channel. The bytes must be unchanged.
- **the realm.** Every binding in constraint 41's list, asserted as an absent BINDING and as a
  failed CALL — both, because the policy refuses `fetch` at the network while an unstripped
  process still holds it.
- **the loader.** A computed `data:` import, `eval` and `new Function` all refused, with the
  realm's own `securitypolicyviolation` event naming `script-src` — the throw cannot attribute the
  refusal, the event can. Positive control: the one same-origin specifier still loads.
- **the fault.** MILESTONES' own words: the bypass snippet with no try/catch. It faults, and
  `/proc/<pid>/status` reads `state: zombie`, `exitkind: 1`, `exitvalue: 6` (SIGABRT). Not "the
  directory is gone" — a reaped process keeps its pid for the quarantine (195).

**Negative controls, one per half, and neither is satisfiable by the other's mechanism.**
`--negative no-lockdown` skips the strip: 14 red, 17 intact — the tamper succeeds
(KERNEL-OWNED-SECRET becomes TAMPERED-BY-PROCESS, and the kernel serves the tampered bytes), and
the bypass program RETURNS instead of dying, which is MILESTONES' "the same program must succeed".
`--negative no-csp` withholds the policy: 8 red, 23 intact — the computed import and `eval` come
back while the realm stays stripped and the volume stays intact.

**Plus a host gate the browser cannot reach.** `lockdown()` refuses to continue when a binding
survives, and on Chrome 157 every target is configurable, so that branch has no caller in a
browser — an unverified mechanism by this repo's own rule. `node bench/m6-realm/probe.mjs` reaches
it with a double (25 checks) and `bench/m6-realm/controls.py` proves the coupling with three
mutations: a shallow delete, the verification removed, and an absent binding credited as stripped.
The mutation harness paid for itself on the first run by catching a clause in the probe that
passed over a report that was never produced.

**One change to the spine.** A program's `run` may now be async and the libos awaits it:
`{ ...promise }` spreads to `{}`, so the unawaited version would have posted an EMPTY result with
nothing saying why. Every capability M6 removes is promise-shaped, so the program that
demonstrates the hole cannot be synchronous (197).

**Six findings from an independent critic, all six fixed, and one was the milestone's own
subject.** `GET /%2fsrc/libos/process.mjs` served `process.mjs` byte-for-byte with NO policy —
`unquote` runs after `urlparse`, `normpath` keeps the two leading slashes, and `translate_path`
collapses them and serves the file anyway — so a process worker created from that URL had an
unbounded module loader. The commit that was supposed to have closed the spelling question had
claimed "including percent-encoded", which was true of an encoded slash in the middle of the path
and not of a leading one. Fixed by asking the resolved FILE rather than the spelling, and the
`%2f` form is now asserted on the wire before Chrome starts. Also fixed: the `/proc` read racing
the 2.2 s quarantine, an abandoned waiter's timer retiring a later waiter, the serialization the
async `run` removed, and two documentation defects. Constraints 201–205.

**AND THEN AN OPERATOR OPENED IT IN FIREFOX, where no process would start at all.** The policy
carried `worker-src 'none'`, and Firefox applies a worker script's own `worker-src` to that
worker's own creation — so it refused to start the very worker the policy describes. The symptom
was `FAULT pid 1: process 1 runtime: error`, because a worker that will not start fires an error
event with an empty message, no filename and line 0: a swallowed failure in the one path this
repository's rules say must name what failed. 394 green expectations could not see it; a human
opening the page saw it immediately (constraints 206, 207).
The directive is out and nothing is lost — the strip deletes `Worker`, `SharedWorker` and
`URL.createObjectURL`, which is the mechanism constraint 53 asked for. **M6 now passes end to end
in Firefox 156 as well as Chrome 157:** verdict ok in 530 ms, same refusals, same intact volume,
same `state: zombie, exitkind: 1, exitvalue: 6`.

**Label honestly, and the docs do:** hardening, not a security boundary. Same-origin is not a
security boundary and the threat model is first-party only for v1. What remains open is written
down rather than implied — `script-src 'self'` still permits any same-origin module (199) — and
M6 ships no document policy on purpose (200).

---

## M7 — a window is a file description · done · 1 day · ~3,000 LoC

**ACCEPT.** One process opens two windows and a pipe and `poll()` wakes it for each in turn — the
milestone's own proof, in `PLAN.md` §5's words — with a REAL browser keystroke arriving on the fd
it was typed into. 42 expectations over six fresh kernels in 17.8 s. The suite is 11 checks and
432 expectations, all green.

```
scripts/check.py                       11 checks, 432 expectations (m7: 42)
scripts/check.py --only m7 --prove-failure   42 inverted, all failed
scripts/check.py --negative win-first-fd     m7 fail:  6 red, 36 intact
scripts/check.py --negative no-cascade       m7 fail: 11 red, 31 intact
node bench/m7-win/probe.mjs            128 host checks (the window table, no browser)
bench/m7-win/controls.py               5 mutations, each scored on which checks move
bench/kernel-churn/probe.py --drop     the program fetch, dropped at the transport
bench/m7-win/drive.py                  the page in a real Chrome, with its evidence printed
bench/m7-win/firefox.py                A SECOND ENGINE: verdict ok in 18.8 s, six of six
```

**AND IT PASSES IN FIREFOX, which is a condition of saying it is done** (`CLAUDE.md`: the suite
drives Chrome only, and that gap has cost two milestones). `bench/m7-win/firefox.py` renders the
page headless and keeps the PNG, because these pages print their own log as text — Mozilla removed
CDP, so there is no driver. The one trick is a slow subresource injected into the served HTML,
which holds the load event open until the proofs have finished; the file on disk is untouched.
**Firefox 156: verdict ok in 18.8 s, all six sections, a live shell at a prompt** — and standing
alone the page types for itself, so the real-keystroke clause reports NOT MEASURED rather than
passing on a synthetic event. It also found the one defect Chrome did not: the window table's own
`win` column was empty, because `Window.report()` calls that field `id`.

**`/dev/console` IS DELETED, WITH THE MECHANISM UNDER IT.** That is what the milestone was for: it
was ONE window, created by the PAGE before any process existed, and a process has one futex word,
so a process holding two windows could not be woken by both (constraint 42). `win_create` returns
an fd and a winid; the window's events are that fd's readable set; `read`, `write`, `poll` and
`close` are the calls that were already there. The chardev machinery in `src/kernel/synth.mjs`, the
`chardev` branch in `open(2)` and the ENXIO it answered went with the one row they served
(constraint 211). What survived unchanged is the ONE decision M4a's special case was carrying: the
`F_WIN` ops row and the row in `pollOne`.

**Built.** `src/kernel/wins.mjs` (the window table, the event ring, the owner chain, the destroy
cascade, the not-responding detector), three appended calls — `win_create` 48, `win_destroy` 49,
`win_set` 50 — the 16-byte `WEV_*` event record with one codec in `src/abi.mjs`,
`/proc/<pid>/win/<winid>` as a file, `src/wm/winhost.mjs` (the page's half: one frame per kernel
window), `src/bin/winopen.mjs` (N windows from the shell, with `-o` for an owned one and `-O` for
an owner in another process), `www/m7.html`, and the migration of `src/bin/term.mjs` and
`www/m4a.html` off the device.

**THE MILESTONE IS A PROGRAM YOU CAN RUN, and that is the point of the page.** `www/m7.html` ends
with a live desktop: a real shell on a real pty in a window a process created, and the kernel's own
window table rendered beside it. From that prompt, `winopen -n 2 -o` opens two more windows and
prints which fd each event arrived on; `q` closes one and the cascade takes the other; `ls
/proc/$$/win` lists the shell's windows as files. `?live=1` skips the proofs.

### The five proofs, and what each control moved

| | Proof | Control | Moves |
| --- | --- | --- | --- |
| 1 | one process, two windows and a pipe, each waking one `poll` | `win-first-fd` evaluates only the FIRST fd of a set | 6 labels — window B, the pipe, the per-fd key identity, the program's reason for exiting, the verdict. Window A still wakes it and the REAL keystroke still arrives |
| 2 | `/proc/<pid>/win` lists the winids; each file names its window, its pid and the fds that reach it | — | held by both controls, which is what says the directory is not the thing being tested |
| 3 | destroying an owner destroys its children, and `win_destroy` returns the list | `no-cascade` destroys a parent alone | 11 labels across proofs 3 and 4 |
| 4 | an owner may name a window in ANOTHER PROCESS, and the cascade crosses the boundary | `no-cascade` | the child survives its owner, and the child process is told nothing |
| 5 | the not-responding detector, both edges | neither | greys at 985–1,009 ms, End Process at 3,990–4,013 ms, clears 4,157–4,224 ms after the process drains |

Proof 5's FIXTURE CHANGED WITH THE MILESTONE and is more honest for it. M4a attached a window with
NO PROCESS READING IT, which `win_create` makes unreachable. The subject now is
`bench/m7-win/wedge.mjs`: a process that creates a window, stops reading it for nine seconds, and
then comes back and drains — a program that was busy and then resumed, which is the case the
caption is actually for. It sleeps rather than spins, because a spinning process starves the kernel
it shares a renderer with (M0's own anti-vacuity control walked into that).

**The detector lost a state.** "(Starting…)" existed because M4a's window had no process yet; with
`win_create` the creating process holds the fd from the window's first instant, so the state is
unreachable and the caption, `openedEver` and `starting()` are deleted (constraint 210).

### What the browser found that the host probe could not

**The headline proof's exit condition was VACUOUS, and it passed.** `poller.mjs` ran until every fd
had woken it once — and the page reports each frame's geometry the instant it builds it, so both
windows had a `WEV_RESIZE` queued before anything was typed and all three fds were ready on the
first poll. Measured: `wokeBy {0:1, 3:1}` with `keysSeen {}`, the program exiting before a key was
pressed. It now runs until each window has delivered a KEY and the pipe bytes or EOF (constraint
214).

**The first window landed on fd 0**, because `spawn` leaves fd 0 free and nothing held it — and in
the same run the pipe in the poll set was `undefined`, because `pipe2` answers `{rfd, wfd}` and the
program read `{read, write}`: `poll` answered POLLNVAL for fd `undefined`, which is READY, so the
pipe's clause passed on an fd that did not exist (constraint 215).

**And the kernel panicked about one run in three.** `programText` bounded the program fetch and
retried once, but only for its own deadline: a `TypeError: Failed to fetch` — the transport, which
is what a page taking ~75 ranged GETs plus four program fetches through one local server
intermittently gets — was rethrown, escaped to `self.onmessage`, which has no `try`/`catch`, and
took the kernel down. The page reported `timed out waiting for spawned` and named nothing, which is
why the page now attaches the kernel's own message kinds to that timeout. Three failures in six
runs before, none in eight after. `bench/kernel-churn/probe.py --drop` is the check, and it fires
both ways. Constraint 212, and it corrects a claim that probe itself was carrying.

### What the mutation harness found, which is three defects in the probe it was scoring

`bench/m7-win/controls.py` mutates `src/kernel/wins.mjs` five ways and scores WHICH host checks
move. On its first run it found that **three of its five mutations were mis-scored because the
probe was weak**, not because the subject was:

- an overflow fixture that pushed 256 IDENTICAL events, so "the oldest came out" held under a
  mutation that dropped the oldest to make room;
- a cascade clause comparing the posted id list against the ids the same call returned — both out
  of the run under test, which is constraint 120's `None == None` in a new place;
- and a probe that DIED on three of the mutations, because `decodeWinEvents` refuses a torn length
  and the probe handed it a negative errno. A harness that cannot report the defect it is pointed
  at is the worst outcome available.

One mutation also returned a RESULT rather than a failure: making the whole-record guard
`free <= 0` moved nothing, because the ring's capacity is a whole number of records and every push
and shift is whole, so the two tests are the same test. The guard is kept as the statement of that
invariant and `src/kernel/wins.mjs` says so where it sits.

### One critic, then six fixes, and the worst was the milestone's own event

M7 went build → independent attack → fix, as every milestone here has. The critic was given the
diff and the acceptance criteria and not the author's account of them. **All six findings were
reproduced against the code before being acted on, and all six are fixed.** The first is the one
that mattered:

| | what it was |
|---|---|
| 217 | **`WEV_CLOSE` could never be read.** `destroy()` cleared the event ring before queueing its own notice, and the page posts `win-in [WEV_CLOSE]` then `win-gone` as two messages — so the close record was wiped two messages later and `src/bin/term.mjs`'s arm for it was dead code. **Nothing in the page or the suite asserted it**, which is why there is now a sixth proof that clicks the real close box |
| — | **`WinMgr.sweep()` had no caller**, so `byId` grew without bound: every created-and-destroyed window kept its 4 KiB ring for ever and the per-heartbeat `sample()` walked all of it — constraint 18 failing by accumulation. `destroyTree` and `F_WIN.close` sweep now, which covers both orders |
| — | **The four `win-*` page handlers dereferenced the window table with no guard**, and `handle()` turns a throw into a panic — so a page message before `boot` killed the kernel. The console they replaced guarded explicitly, and `windowSample()` still did |
| — | **`win-geom` was not in the page's UNSOLICITED set**, so every frame report — on create, on every pointerup, on every title-bar keyup — sat in `pending` for ever. Exactly the leak the comment beside it warns about |
| — | **`bench/m7-win/poller.mjs` hot-spun on `-EHOSTGONE`**: a destroyed window is readable for ever, so an fd left in the poll set made `poll` answer immediately on every turn and the loop span at renderer speed with no pacing — the defect `wedge.mjs` chose `nanosleep` to avoid |
| 210 | **Half of the "(Starting…)" state was still here** — the parameter, the field, the caption branch, the class, the dataset flag and the CSS rule — in a commit that cites a constraint to delete it |

**Then the sixth proof's own run found the rest of constraint 212.** With the page at six kernels,
a run lost BOTH attempts at a program fetch in the same instant: the retry was immediate, and the
server's listen backlog was `socketserver`'s default of five against a burst of six. `serve.Server`
raises it to 128 and the retry waits 60 ms; `scripts/check.py` and `bench/kernel-churn/probe.py`
build their servers from that one class now. What remains is Chrome's own worker startup, and the
page retries that once and says so (constraint 218).

### What is not done

`WEV_CLOSE` is DELIVERED and the frame still goes: M9 owns the refusal, and a relay that pretended
to refuse would be lying to the user. There is no surface — a window shows what a process `write`s
to it as text, and M8 is the transferred `OffscreenCanvas`. `modal` does not exist. A window's
position is recorded and raises no event, because nothing acts on it. The taskbar's cross-process
enumeration is still the second, separately-gated interface `CLAUDE.md` describes and no part of it
is built.

---

## M8 — the window surface · done · 0.5 days · ~1,800 LoC

**ACCEPT.** A process draws a known pattern and the pixels are on the canvas, read back out of the
canvas the browser painted; a REAL MOUSE DRAG reaches the process as pointer events and what it
draws lands where the pointer went. 28 expectations over four fresh kernels in 1.7 s — the fastest
window check, because nothing here waits on a threshold. The suite is 12 checks and 460
expectations, all green.

```
scripts/check.py                       12 checks, 462 expectations (m8: 30)
scripts/check.py --only m8 --prove-failure   30 inverted, all failed
scripts/check.py --negative no-draw          m8 fail: 7 red, 23 intact
node bench/m8-surface/probe.mjs        51 host checks (the accounting and the codec, no browser)
bench/m8-surface/shell.py              `paint` TYPED AT A PROMPT, which no check does
bench/m8-surface/controls.py           5 mutations, each scored on which checks move
bench/m8-surface/probe.py              THE PREREQUISITE EXPERIMENT, which reversed the design
bench/m7-win/firefox.py --page m8      A SECOND ENGINE: verdict ok in 3.4 s, four of four
```

### The experiment came first, and it reversed the plan

`PLAN.md` §5 and `CLAUDE.md` both said a window's surface would be a TRANSFERRED `OffscreenCanvas`
— "which is why the window ABI is `win_*` calls and not a `/dev/wm` device file: a file write
cannot transfer a handle". Nobody had measured whether the transfer can ARRIVE.
`bench/m8-surface/probe.py` measures it against a worker shaped like a process:

| the worker had the canvas | |
| --- | --- |
| after 400 ms of synchronous work | **no** |
| after 600 ms parked in `Atomics.wait` | **no** — the one that decides it |
| after awaiting one macrotask | **yes**, 594 ms after it was posted |
| drawing on it then | `rgba(74,155,216,255)`: it works once it is there |
| the page's own copy afterwards | detached, so there is no front/back pair |

`postMessage` needs an event-loop turn and a process turns its loop only where a program `await`s —
which no synchronous program does and which the syscall stub cannot do, being synchronous by
construction. **So a surface cannot be the reply to the syscall that asked for it.** It could be
made to work, and the cost would be that every drawing program is async by obligation, that the
kernel has given away something it can neither account nor revoke (which M12's governor needs), and
that a releasable resource lives in a process worker (constraint 15).

**The surface is therefore kernel-owned, and a process draws by sending a DISPLAY LIST** through
the byte region it already has — one syscall per batch, not per operation. Constraint 219 and
`docs/DECISIONS.md` D31; `CLAUDE.md`, `PLAN.md` §5 and `docs/ABI.md` are corrected where they said
otherwise.

**Built.** `win_surface` (51) and `win_draw` (52), the 32-byte `DL_*` op with one codec in
`src/abi.mjs`, the surface budget and its revocation in `src/kernel/wins.mjs`, `WEV_POINTER`,
`src/wm/surface.mjs` (the ONE renderer of a display list), the host's content-mode switch,
`/usr/bin/paint`, `www/m8.html`, and `www/pagekernel.mjs` — the page's half of a kernel, extracted
because M7's page and M8's both need all of it.

**THE MILESTONE IS A PROGRAM YOU CAN RUN.** From the live desktop at the bottom of `www/m8.html`:
`paint` opens a window you draw in with the mouse — 1–6 pick a colour, `c` clears, `q` quits — and
every pixel is a display list through a syscall. `paint -t` draws the pattern this page asserts on
and leaves it on screen. `cat /proc/$$/win/*` shows every window as a file, surface size included.

### The four proofs, and what the control moved

| | Proof | |
| --- | --- | --- |
| 1 | a process draws a known pattern and EVERY PIXEL IS ON THE CANVAS | read back at the centre of each square, plus one pixel NOTHING drew on — which is what stops a canvas filled with the pattern's own colour from satisfying the rest |
| 2 | a REAL MOUSE DRAG reaches the process and the pixels under it change | `Input.dispatchMouseEvent` at coordinates the page publishes from the canvas's own rectangle; several moves, because a program drawing from its last point needs two points. A corner the drag never reached must NOT change |
| 3 | the budget refuses by name and gives the area back | 18 window-sized surfaces granted, the 19th ENOMEM, EINVAL for one past the per-surface cap, and the same size granted again after the windows were destroyed |
| 4 | one content mode per window | `write(2)` on a surfaced window is EINVAL while a draw still succeeds |

**`--negative no-draw`** makes `win_draw` accept its batch, count it and discard it — `PLAN.md`
§5's own words, "draw nothing; the pattern assertion must fail". **7 red, 21 intact**: the process
still gets its surface, still reports the batch it sent, still SEES the real pointer events and
still draws in response; the budget and the cell refusal are untouched. What disappears is the
pixels, which is the only cut that tells a working surface from a page that drew something of its
own.

### What the first runs found, and both looked like failures

**One colour, two renderings.** The pattern proof compared `cssColor(op.a4)` — for a canvas, alpha
0–1 — against a pixel read out of that canvas, where `getImageData` reports alpha as a 0–255 byte.
Four clauses red over four pixels that were exactly right. `src/abi.mjs` renders both from one
unpacking now and `selfTest` asserts they differ only in the alpha (constraint 224).

**A frame report for a window that is gone is a race, not an error.** The kernel posted an `error`
for it, and a program that created and destroyed eighteen windows turned a green check red with
four of them. The page cannot avoid it — it builds a frame when the kernel says so and reports the
box its clamp settled on, and a process can destroy the window while both messages are still
queued. Counted as `lateGeoms` now, because a page reporting geometry for windows that never
existed WOULD be a defect.

**And the mutation harness found three weak assertions in its own probe**, as M7's did: a clause
named after the area it did not check, a mutation that crashed the probe instead of scoring it, and
three counts that moved as a consequence of one removal and had to be declared rather than excused.

### One critic, then twelve fixes, and the first one accepted a lie

M8 went build → independent attack → fix. **All twelve findings were reproduced against the code
before being acted on, and all twelve are fixed.** Four are worth reading before trusting anything
similar; constraint 225 carries them with the measurement each rests on.

| | what it was |
|---|---|
| 225 | **`win_draw` was the only handler that did not bound its byte length by `MAX_INLINE`.** It checked the length against the declared op count and nothing else, and `subarray` CLAMPS — so a caller declaring 3,000 ops had the kernel charge 2,043.875 ops, the page replay 2,043 ops of whatever the region last held, and the call return **0** |
| 225 | **The page's replay truncated a torn batch**, which made the refusal its own docstring promised unreachable from the only caller that matters |
| 225 | **A pointer coordinate is signed and the event record is not.** A capture keeps delivering moves after the pointer leaves the surface, so a negative x is the normal case — and it read back as 4,294,967,289. `pointerAt` is the one place that is undone |
| 225 | **A surfaced window stopped emitting focus events, and its keys stopped being counted.** Both belonged to the text widget the surface replaces, so a surfaced window could have satisfied a "real keystroke" clause with a key the page dispatched to itself |

The other eight: the record size written as a literal twice (which admitted a fractional op count),
the content-mode refusal counted as a dead frame's, two harness clauses that named more than they
asserted, a mutation whose name did not match its substitution, dead code the `pagekernel.mjs`
extraction left behind, a comment naming a field the record does not have, and a screenshot taken
twice.

**Two of them became checks rather than just fixes**, because a fixed bug is a check: the lying
batch is four refusals and one acceptance through `env.syscall` — the libos would never send a
lying count, so the only way to reach the guard is to make the call it protects the kernel from —
and the focus event is a clause on `paint`'s own counter.

### And it runs from the shell, which is the path a person takes

`bench/m8-surface/shell.py` opens the live desktop in a real Chrome, types `paint -w 160 -h 120` at
the prompt, and asserts a surface appeared AND that something was drawn on it: 19,200 painted
pixels, none of which the page put there. **No check did this**: they spawn programs by URL, which
is the page's supervisor path (`docs/DECISIONS.md` D18), and M6's own history is the reason to care
— a program that ran from the page was refused from the filesystem, and only running it from the
shell found that (constraint 208).

### What is not done

There is no text op, so a surface cannot draw a string: M8's vocabulary is clear, fill, stroke and
line. A hover is not sent, because one event per `pointermove` would overflow a window's 256-record
queue in about a second (constraint 223) — a program that needs hover can ask when there is one.
The surface does not follow the frame: it is the process's own choice of resolution and the page
scales it, so a program that wants to match its window asks for a new surface. And the budget only
REFUSES: M12's governor is the thing that admits and degrades, and it now has a number to do it
against.

---

## M9 — owner, modality, close-request · done · 0.5 days · ~1,900 LoC

**ACCEPT.** A dialog stays above the window that owns it; a REAL mouse click on that window is
refused by the kernel, which names the blocker; typing into the blocked window changes nothing and
the kernel says how much it ate; and the X button asks instead of acting — Esc refuses the close,
the editor is editable again, and answering destroys every owned window through M7's cascade. 32
expectations over three fresh kernels in 3.4 s. The suite is 13 checks and 494 expectations, all
green.

```
scripts/check.py                       13 checks, 494 expectations (m9: 32)
scripts/check.py --only m9 --prove-failure   32 inverted, all failed
scripts/check.py --negative no-owner-chain   m9 fail:  3 red, 29 intact
scripts/check.py --negative no-modal         m9 fail: 11 red, 21 intact
node bench/m9-modal/probe.mjs          58 host checks (the stack, the chain, the walk)
bench/m9-modal/controls.py             5 mutations, each scored on which checks move
bench/m9-modal/shell.py                `editor` typed at a REAL prompt, its X clicked
bench/m9-modal/shell.py --clean        ...and the SAME click on a clean buffer, which closes
```

### The kernel owns the stack, and that is the structural half

Modality is a rule about which window may be on top and which may receive input. Both are the
page's natural business — it has the DOM — and neither can be left there: **a page asked to raise a
window above the modal that blocks it has no way to know better, and would.** So `win_raise` (53)
is a syscall, the kernel computes the blocker by walking the owner chain, and `win-stack` carries
the WHOLE order to the page rather than a "raise this one" instruction. The page renders an order
it is handed and never decides it. Constraint 226, `docs/DECISIONS.md` D32, and SerenityOS's server
does the same thing in `Window::blocking_modal_window`.

**INPUT SUPPRESSION IS THE OTHER HALF, and without it "modal" means only "stays on top."** A key or
a pointer to a blocked window is refused and counted in `/proc/<pid>/win/<winid>`; a resize, a
focus change, a close request and a destroy notice are NOT, because a window that missed those
would be wrong about the world once the modal went away.

**Built.** `win_raise`, `WIN_SET_MODAL` with its two axes, the stack and the blocker walk in
`src/kernel/wins.mjs`, input suppression in `feed`, the page's stack renderer and blocked-flash in
`src/wm/winhost.mjs`, `/usr/bin/editor`, `www/m9.html`, and `/proc`'s `scope`, `mode` and
`suppressed` fields.

**AN OWNED WINDOW IS TWO AXES, AND THIS MILESTONE'S PLAN HAD ONE.** `modal ∈ {none, window, app,
system}` is the SCOPE; SerenityOS's `WindowMode` is the BEHAVIOUR. `MILESTONES.md`'s own ordering
correction said both were needed, and the editor is the proof: it opens a **palette** that is
`RENDER_ABOVE` and blocks nothing, and a **dialog** that is `BLOCKING`. Both are "owned by that
window" and nothing else about them is the same (constraint 227).

**AND IT WAS RUN FROM A REAL PROMPT, NOT SPAWNED BY URL.** `bench/m9-modal/shell.py` types
`editor` at the desktop's prompt, types into the window, clicks the real close box, and reads the
frames back: 3 frames become 4, the dialog sits at depth 3 over an editor at depth 1, and the editor
is still there. **`--clean` is its negative control and it is the SAME CLICK** — nothing typed, so a
clean buffer closes at once and 3 frames become 1. Without that run, "the window is still there"
would also be what a close box that does nothing looks like.

**THE MILESTONE IS A PROGRAM YOU CAN RUN.** From the live desktop at the bottom of `www/m9.html`:
`editor` opens a window you type in, with its tool palette above it. Press the X and **it does not
close** — a dialog appears, the editor is still there behind it, clicking the editor's title bar
will not raise it and the dialog flashes, and typing into the editor arrives nowhere. Esc keeps
editing; y or n closes both. `editor -a` makes the dialog APP-modal, which blocks the editor's
second window too; `winopen -n 1` opens an unrelated process's window, which a window-modal dialog
does NOT block.

### The four proofs, and what each control moved

| | Proof | |
| --- | --- | --- |
| 1 | the owner chain and the refusal | raising the editor brings its palette up with it; the dialog sits above its owner and the page renders that; a REAL click on the owner is refused, the blocker is named, and the order does not change at all; an unrelated process's window still raises |
| 2 | input suppression | typing into the blocked editor changes nothing on its screen, the kernel's `suppressed` counter moves, and nothing is left queued |
| 3 | the close is a request | the X opens a dialog and closes nothing; Esc refuses and the editor is editable again; answering destroys all three owned windows through the cascade |
| 4 | the two axes are two | an APP-modal dialog refuses a raise of a SIBLING window of the same process and suppresses its input — which a window-modal one does not |

**`--negative no-owner-chain`** raises a window without the dialogs that ride with it — `PLAN.md`
§5's own words, "the dialog must fall behind". 3 red, 29 intact: the refusal still happens, because
the modal still blocks. **`--negative no-modal`** makes nothing blocking: 11 red, 21 intact, and
what HOLDS is the whole close contract, because that half of M9 has nothing to do with modality. A
control that broke both halves could not tell them apart.

### What the controls found, and the first one was a defect

**THE BLOCKER WALK WAS WRITTEN BACKWARDS.** A blocking window blocks nobody in ITS OWN subtree;
the first version excluded the RAISING window's subtree instead, which is the same sentence read
backwards — so a save dialog, being its editor's child, could not block the editor that owns it.
**The stack order looked right the whole time**, because a dialog rides up with its owner either
way; what gave it away was typing into the blocked window and watching the characters arrive. It is
`bench/m9-modal/controls.py --only backwards-subtree` now, and it moves 17 checks in both
directions — the blocks that disappear AND the windows that become wrongly blocked.

**AND THE CONTROLS FOUND TWO PROOFS THAT COULD NOT SEE THEIR OWN SUBJECT:**

- **`--negative no-owner-chain` came out GREEN** against a check that claimed to be about the
  chain. With the modal already up, a raise of the editor is REFUSED — so removing the riders
  changed nothing. The chain is only observable when a raise is GRANTED, which is why the editor
  now has a palette and the proof raises the editor *before* the dialog exists.
- **`--negative no-modal` held a clause that asserted the order had not changed**, twice over:
  first because the clause checked only the TOP of the stack, and a `BLOCKING` dialog rides up with
  its owner either way; then because the editor was already above the stranger, so a granted raise
  produced the same order as a refused one. The clause compares the whole order now, and the proof
  buries the editor first.

**Two harness defects went with them**, both the repo's own documented traps: the probe indexed
`postsOf(t)[0]` directly and DIED on the failure it was testing for, and its failure report grew
past 64 KiB under one mutation so the pipe truncated the JSON and the control could not parse the
result it had asked for.

### What this changed in M7

**M7's close proof asserted the old contract.** It required a `WEV_DESTROYED` record to arrive as
well as the close, which was right when the PAGE destroyed the window: the program learned by
event. Under M9 the program destroys its own window and is not told — it does not need to be — so
the clause now asserts that the PROGRAM is what acts, by the ids `win_destroy` returns. The notice
is still asserted where it is still the subject: the cross-process cascade, where another process's
call takes your window down. `winopen` honours a close request now, which is what a program with
nothing to save should do.

### What is not done

Nobody may raise another process's window except on a user's click: a management interface that
could is the second, separately-gated interface `CLAUDE.md` describes for the taskbar, and M14 owns
it. `WMODE_PASSIVE` rides up exactly as `RENDER_ABOVE` does — the two differ in SerenityOS by
whether they take focus, and nothing here has focus to take yet. There is no keyboard route to a
modal (no Tab, no Escape handling in the host), so a dialog is answered by typing into it. And the
flash that marks a refused raise is one frame of a CSS class; M11's skin is where that becomes
something designed.

---

### What the critic changed, and two bugs a reader found

**M9 WENT TO AN INDEPENDENT CRITIC WITH NONE OF THE AUTHOR'S CONTEXT, and it returned nine
findings.** Every one was verified against the code before it was acted on; every one became a
check. Two were user-visible and neither had anything to do with modality:

| | |
| --- | --- |
| `appOf` read the owner chain FROM THE WRONG END | `ancestors()` is nearest-first, so an APP-modal dialog three deep froze the process at the TOP of the chain and left its own owner typable and raisable over itself. Depth-1 chains cannot tell the two readings apart, and every fixture was depth 1 (229) |
| `create` grew the stack and posted no ORDER | the kernel was right and the screen was wrong: the page assigns a `z-index` only when it renders an order, so a clicked window had one and a window created afterwards had none — and painted behind it. Click a window, then `winopen` (230) |

The other seven: `blockingFor` ran the whole table walk per pointer sample (231); a PASSIVE window
raised directly took the global stack (232); suppression covered the client area and not the frame,
so a blocked window could still be DRAGGED under its own modal (233); the ownerless-modal guard
tested `scope === 1 || scope === 2`, the enum's order copied into a second file (234); one counter
carried two different page races (235); `WMODAL_SYSTEM` needs no privilege and the escape hatch
constraint 228 promised did not exist for it (236); and `bench/m9-modal/controls.py` scored an
empty `moves` tuple as a PASS, which is how a control that broke the APP-scope rule and moved zero
checks was reported as verified (237).

**ONE FIX WAS WRONG ON THE FIRST ATTEMPT AND THE PROBE CAUGHT IT.** `anyBlocking()` started as an
epoch-invalidated cache, and it answered stale for every caller that writes `mode` directly — which
the host probe does, so twelve assertions about suppression went green against a kernel that was
suppressing nothing. A derived value is recomputed from its source. The cost that fix is about was
the subtree walk, never the mode test.

```
scripts/check.py --only m9              41 expectations (was 32)
node bench/m9-modal/probe.mjs           79 host checks (was 58)
bench/m9-modal/controls.py              8 mutations (was 5), each scored on which checks move
scripts/check.py --negative no-owner-chain   m9 fail:  3 red, 38 intact
scripts/check.py --negative no-modal         m9 fail: 15 red, 26 intact
```

**AND TWO BUGS CAME FROM A READER USING THE DESKTOP**, which 494 passing expectations had not
touched — because every check reaches the filesystem and the terminal through the page's supervisor
path, and a person reaches them by typing.

- **`ls /` PRINTED NOTHING, AND `cd /usr/..` ANSWERED ENOENT.** The mount table resolves by longest
  component prefix, so `/usr` worked without existing on the volume beneath it. One cause, two
  symptoms. The kernel creates each mountpoint as a directory before mounting over it, and the
  mount table stops being a second, invisible namespace (238). `--negative no-mountpoints` is the
  world the reader met: one red, 38 intact.
- **A SECOND TERMINAL DIED AFTER 30 SECONDS.** `term`'s ceiling bounded the whole session, and
  every page passes `--ceiling 3600000` — so the only caller left on the 30-second default was a
  human typing `term &`. It bounds IDLE time now, measured from after setup rather than from entry,
  and both edges are checked (239). `term &` is in every live page's hint block, because the
  complaint was also that nothing said it existed.

`bench/shell-reports/repro.py` is where both are driven at a real prompt, and it is the file to
extend the next time a milestone is reported done and a reader finds something in five minutes.

---

## M10 — a typed clipboard and drag-and-drop · done · 0.5 days · ~3,400 LoC

**ACCEPT.** `clip copy /usr/share/logo.rgba` at a real prompt, `imgview &`, press `v` — and the
logo is on the canvas, drawn one `DL_FILL_RECT` per pixel from bytes the kernel carried. `files &`
beside it, and a REAL MOUSE drags a file row from one process's window into another's: the title
reads "dragging logo.rgba", the kernel names the target, the page draws the highlight, and the
receiver reports a 16x16 bitmap and paints it. Drag `readme.txt` instead and it refuses BY NAME
rather than drawing a filename as a picture. 37 expectations over five fresh kernels in 5.3 s. The
suite is 14 checks and 542 expectations, all green.

```
scripts/check.py                       14 checks, 542 expectations (m10: 37)
scripts/check.py --only m10 --prove-failure   37 inverted, all failed
scripts/check.py --negative text-only  m10 fail: 17 red, 20 intact
scripts/check.py --negative no-drop    m10 fail:  7 red, 30 intact
node bench/m10-data/probe.mjs          164 host checks (the lifetimes, the refusals, the edges)
bench/m10-data/controls.py             11 mutations, each scored on which checks move
bench/m10-data/shell.py                `files &` and `imgview &` at a REAL prompt, a REAL drag
bench/m10-data/shell.py --row 2        ...and the SAME gesture with a text file, which is refused
bench/m10-data/shell.py --clip         `clip copy` then `v`, which is the route a terminal has
bench/m7-win/firefox.py --page m10     all four proofs in a second engine
```

### The defect was in the ABI, not in the feature list

`docs/designs/REVIEW-FINDINGS.md` §2 asked for drag-and-drop, and the line that actually decided
this milestone's shape was about the clipboard: `clipboard_write(bytes)` "leaves a receiver
structurally unable to distinguish a pasted PNG from pasted UTF-8". That is a defect in a published
call, not a missing feature — so the two untyped `clipboard_*` calls are **DELETED** and five typed
`dataobj_*` calls replace them (constraint 240). The ABI is 71 calls now and says so.

**THE CLIPBOARD AND A DRAG ARE ONE OBJECT PUBLISHED TO TWO PLACES**, which is why `offer` and `open`
are two calls rather than four: they differ by an argument, and one knob controls one behaviour.

**AND THE PAYLOAD IS KERNEL-OWNED, which is what makes either gesture work at all.** A clipboard
whose bytes lived in the copying process is empty the moment that process exits; the review's own
requirement is that a drag survive its source "entering DYING mid-drag". So an object is refcounted
kernel-side and a process holds an **fd** — `F_DATA` — which means `close(2)`, `dup`, spawn
inheritance and reap teardown already release it and a process still holds only integers
(constraints 15, 241). `read(2)` and `write(2)` on one are -EINVAL, which is the deleted call's
defect stated as code.

**Built.** `src/kernel/dataobj.mjs` (the objects, the clipboard slot, the drag session, the budget),
five handlers in `src/kernel/calls.mjs`, the `F_DATA` row in `src/kernel/files.mjs`, the format
table and codecs in `src/abi.mjs`, `/proc/dataobj`, `env.data` in the libos, the page's half of the
gesture in `src/wm/winhost.mjs`, `Surface.clientAt`, `/usr/bin/clip`, `/usr/bin/files`,
`/usr/bin/imgview`, the first three data files in `/usr/share`, and `www/m10.html`.

### The four proofs, and what each control moved

| | Proof | |
| --- | --- | --- |
| 1 | the clipboard carries an IMAGE across processes | `clip` publishes a path list AND a bitmap, is KILLED with End Process, and a third process pastes and draws it — the logo's amber corner pixel beside its blue neighbour, read back out of the canvas |
| 2 | a REAL MOUSE drags a row between two processes' windows | one session, one enter, one drop; the bytes arrive under the IMAGE format, the receiver draws them, the source is told the effect, and the payload is released when the receiver closes its fd |
| 3 | a text-only object offered to an image view is refused BY NAME | -ENOTSUP, naming what the object did offer, and NOTHING is drawn as an image |
| 4 | the payload is accounted and the page cannot forge a drop | a PNG is carried without being decoded (its IHDR is read back), the budget holds while anything references it, and two `WEV_DROP` records fed through the page's own route are refused and counted |

**`--negative text-only`** makes every object offer TEXT alone — `PLAN.md` §5's own words, "offer
only the text format; the image paste must fail cleanly, not silently paste a path". 16 red, 21
intact: **both gestures still run end to end** — the clipboard publishes, a program reads it out of
`/proc/dataobj`, the real mouse opens one session, the target is entered once, the drop is delivered
and the source is told the effect — and the whole REFUSAL proof holds, because a clean ENOTSUP is
exactly what that world should produce. **`--negative no-drop`** delivers no drop: 7 red, 30 intact,
and what holds is the entire clipboard half. A control that broke both gestures could not say which
one it removed.

### What the controls found, and the first one broke the world

**THE FIRST `text-only` RUN TURNED 21 OF 25 CLAUSES RED, and that was a defect in two programs
rather than a control working.** `clip` and `files` treated a refused format as fatal, so under
text-only `clip` published nothing and `files` never started a drag: the clipboard was empty, the
gesture never ran, and the control was satisfied by a world with no clipboard in it. A control
satisfied by that verifies nothing about TYPES.

Both programs **write what the kernel GRANTED, not what they asked for** now — `dataobj_create`
returns the offer it settled on and it may be narrower — and they never SUBSTITUTE: writing the path
as TEXT because TEXT is what was granted is precisely the failure being prevented (constraint 247).

**AND IT FOUND A CLAUSE THAT COULD NOT SEE ITS OWN SUBJECT.** "the paste drew the image" asserted
only that the surface's op count had moved — which an image view drawing its own REFUSAL satisfies,
measured: five ops of pink band under the control, clause green. It asserts the receiver's own
report of the format now. A second one, "and it refuses to draw what it cannot decode", HELD under
the control because no PNG arrived at all; it asserts a PNG that arrived and was not drawn.

### The arithmetic the browser cannot reach, and the nine mutations over it

Everything that can go wrong here is a COUNT: a reference taken twice leaks the payload for the
life of the kernel, one released twice frees an object another process is reading, and a drop
retained for an event that was never queued holds the budget until its window dies. None of that is
visible on a screen. `bench/m10-data/probe.mjs` is 164 checks under plain node and
`bench/m10-data/controls.py` is eleven mutations scored on which of them move — every one a plausible
implementation:

| | |
| --- | --- |
| `leak-on-lost-drop` | retain the payload before looking at whether the target queued the record — the obvious order, and the one that charges the budget for a collection that can never happen (constraint 245) |
| `repeatable-drop` | leave a collected drop in the pending map, so one open hands out a reference per call |
| `unsealed-publish` | publishing does not seal, so a source rewrites bytes two processes are reading |
| `no-gesture-gate` | a drag with no button down, which then holds the one session until the idle bound fires |
| `drag-over-per-sample` | an event per motion sample, which laps a 256-record queue in about a second and drops the DROP |
| `session-age-bound` | bound the gesture's AGE rather than its idle time — `term`'s own bug (constraint 239) |
| `blocked-is-a-target` | a window behind a modal may be dropped on |
| `offer-not-narrowed` | store the offer as asked, so a bit nobody defines reaches a target |
| `one-budget-for-two-ceilings` | -ENOMEM for the object's own ceiling as well as the system's |

**ONE MUTATION KILLED THE PROBE, which is the trap this repo has walked into twice.**
`session-age-bound` cancels the session on the first tick, and the probe read `report().drag.idleMs`
directly — so it died on the failure it was testing for and reported nothing. A safe accessor, the
same fix m9's probe needed.

**AND THE PROBE CAUGHT A REAL BUG BEFORE ANY BROWSER RAN: `DataMgr` had TWO METHODS NAMED `get`.**
The table lookup and the payload reader, in one class body — the later one silently replaces the
first in JavaScript, so the lookup simply disappeared and the first symptom was a TypeError inside a
check about something else. The payload reader is `fetch` now, and the note is in the file.

### It runs from a prompt, which is the path a reader takes

`bench/m10-data/shell.py` types `files &` and `imgview &` at a REAL prompt and drags between them
with a REAL mouse, and reads the receiver's canvas back. **`--row 2` is its negative control and it
is the SAME GESTURE** — the third row is `readme.txt`, so the image view must refuse it and draw
nothing. **`--clip` is the route a terminal has**, since a text window cannot be a drag source: only
a surface delivers pointer events to a process (constraint 248).

That file exists because the two bugs a reader found in five minutes after M9 was reported done were
both on this path and not on the page's supervisor path (constraints 238, 239). It is the discipline
applied before the report rather than after it.

### What the critic changed, and the worst of it was a LEAVE

**M10 WENT TO AN INDEPENDENT CRITIC WITH NONE OF THE AUTHOR'S CONTEXT, and it returned six
findings.** Every one was verified against the code before it was acted on; every one became a
check. Two were user-visible:

| | |
| --- | --- |
| a window entered and then BLOCKED never got its `WEV_DRAG_LEAVE` | `dragAt` resolved the window it was leaving through the same filter that decides whether a window may be a TARGET. Its hover frame then stays on screen for the rest of its life and its enter/leave counts never balance. M9's rule read correctly: an ENTER is input and a modal refuses it, a LEAVE RETRACTS something already delivered (249) |
| `/usr/share/logo.png` was SPAWNABLE | every row of the provider mount was mode 0o555, and its own comment claimed the execute check would "fail on a data file". Until M10 every row was a program, so the claim could not be observed; the first three data files falsified it. Per-row modes now, and the shell answers EACCES (250) |

**AND READING THE FIRST ONE FOUND A SECOND INSTANCE OF IT.** A session that ended without
delivering a drop — an idle cancellation, or a drop whose event could not queue — also left its
target believing the pointer was still over it. Both are mutations now
(`--only leave-through-targetof`, `--only no-leave-on-end`), and the eleven mutations in this
milestone are nine plus those two.

The other four: a data-object fd reported itself ALWAYS READY to `poll`, through the arm meant for
a regular file, so a program holding a clipboard fd beside its window fd spun instead of parking
(251); the libos's chunking loop left a TRUNCATED payload when the kernel refused mid-write, which
is the one place `src/abi.mjs`'s "a refusal and not a short count" could be broken (252); two
refusal paths in `imgview` returned before appending their row, so a real failure arrived as the
PREVIOUS paste's evidence (253); and "a program reads the clipboard out of /proc/dataobj" grepped a
label that is printed even for an EMPTY clipboard — so it passed in a world with nothing on the
clipboard, and sat in `--negative text-only`'s HELD list while doing it (254).

**THAT LAST ONE IS THE SECOND MIS-COUPLED CLAUSE THIS MILESTONE SHIPPED**, after "the paste drew
the image" was satisfied by a window drawing its own refusal. Both were assertions over a SYMPTOM
that a working world and a broken one produce alike, and in both cases the control was the thing
that could have caught it — one did, one did not.

### What is not done

**A DROP TARGET CANNOT NEGOTIATE.** Windows' `IDropTarget` answers a drop effect — "I would take a
copy but not a move" — and there is nothing here with two answers yet, so the effect reported to a
source is the source's own preference order, COPY before MOVE. **There is no `DRAG_OVER`** and the
reason is arithmetic rather than scope (constraint 243); a target that needs continuous feedback can
have it when a program needs it. **Nothing decodes PNG**, so an image view reads its IHDR and
reports the size rather than drawing it; the picture a reader sees comes from `DOBJ_BITMAP`, which
is the one image format fill-rects can draw. **There is no bridge to the HOST clipboard** — the
browser's own clipboard is gesture-gated and asynchronous, and this one is a kernel slot. **The
format table is closed**, which the review that asked for this asked to be registerable; the offer
is a bitmask in one register because a target must decide mid-gesture, and that is recorded as the
departure it is. **And a file manager cannot MOVE a file yet**: `files` offers COPY only, so nothing
exercises the effect a `DOBJ_EFFECT_MOVE` source would have to act on.

---

## M11 — Aero glass, frame-only · done · 0.5 days · ~2,600 LoC

`src/wm/aero.mjs` is every number Windows 7's glass is made of, once, plus the stylesheet derived
from them. `src/wm/window.mjs` builds the frame as **four separately filtered strips** and a client
area. `scripts/png.py` is a stdlib PNG reader, because the question "did it blur" is only answerable
from a screenshot. `www/m11.html` is six proofs and then a live Aero desktop.

### The experiment came first, and it corrected a decision's headline number

`bench/m11-glass/probe.py` ran before any of the skin was written, for M8's reason: the thing about
to be built rested on a figure nobody had measured.

**`backdrop-filter` filters the element's BORDER BOX.** So "frame-only glass" is only frame-only if
the frame is several filtered boxes that sum to the ring. One glass node with an opaque client child
painted over its middle hides the blur and **saves none of it**. Measured at 640×440, dpr 2,
Chrome 157:

| geometry | filtered CSS px² | glass nodes | windows to gap-04's 58 M wall |
| --- | --- | --- | --- |
| one box node | 281,600 | 1 | **51** |
| four strips | 27,260 | 4 | **531** |

The box figure reproduces gap-04's own measured "~51 windows of 640×440" **exactly**, which is what
makes the ring figure trustworthy: one accounting, applied to two geometries. So `docs/DECISIONS.md`
D13's "~11× cheaper" is **true of the ring and false of the box** — 10.33× measured — and
`docs/designs/REVIEW-FINDINGS.md` §3, which raised this against a sibling design, lands on this one
too. The four-strip geometry is what was built, and `aero.ringArea` is the one definition of its
area, which **M12's admission controller must call rather than restate** (constraint 49).

**It also answered whether the suite can ask the question at all.** `scripts/check.py` drives
`--headless=new` with `--disable-gpu` and SwiftShader, and gap-04's whole Aero budget was measured
in a *headed* window at 120 Hz. The blur reaches the compositor in both: concentration 0.078
headless against 0.077 headed, with the bare seam at 1.000 in each. So the pixel proof lives in the
suite. A frame-rate figure still cannot — that is M12's problem and is recorded below.

### "A monotonic gradient" is not an assertion, and that is the first correction

`PLAN.md` §5 specifies M11's proof as "sample a 16 px column across a black/white backdrop seam
behind the caption and assert a **monotonic gradient**". **Measured, a hard step is monotonic.** The
bare seam, a `blur(0px)` control, a `backdrop-filter: none` control and a severed blur chain all
report a monotonic rise. An assertion that every one of its own negative controls satisfies is
constraint 39's defect wearing a new name.

What separates a blur from a step is **concentration**: the share of the whole transition falling
between one adjacent pair of samples. A step puts all of it there and reads 1.00; a blur spreads it.

| | concentration |
| --- | --- |
| glass, headless | 0.078 |
| glass, headed | 0.077 |
| `blur(0px)` | 0.963 |
| `backdrop-filter: none` | 0.982 |
| severed chain | 0.982 |
| bare seam | 1.000 |

The threshold is 0.35, in the empty middle with a factor of four either side.

### And the control `PLAN.md` named is the wrong one — which is the second correction

§5's negative control is "set `backdrop-filter: none`; the gradient assertion must fail".
`docs/designs/REVIEW-FINDINGS.md` §8 had already measured why that is the weaker cut: removing the
property also removes the isolated group the `plus-lighter` layers blend into, so it moves the
sampled pixel by (31,46,71) for a reason that has **nothing to do with blurring**.

`--negative no-blur` is the strict one: the isolation, the brightness, the additive layers and the
active/inactive brightness pair all stay, and only the standard deviation goes to zero. Both are
registered, because the comparison is the finding — `none` moves seven labels, `blur(0px)` moves
one.

### The six proofs, and what each control moved

| | proof | what it asserts |
| --- | --- | --- |
| 1 | the ring is the ring | four strips, summing to `aero.ringArea`, with the frame and the client area filtering nothing |
| 2 | nothing severs the chain | no ancestor of any strip carries opacity<1, a filter, a mask, a clip-path or a mix-blend-mode; both additive layers sit INSIDE a strip |
| 3 | the glass blurs | the caption's band across a hard seam reads as a spread ramp, against the bare seam as a step |
| 4 | the caption is legible | local contrast ≥ 4.5:1 inside the glyph band on BOTH sides of the seam |
| 5 | minimize and maximize are inert | drawn, `disabled`, labelled, and clicking both leaves the box where it was |
| 6 | inactive glass is brighter | the blur balance RISES to 0.796 and the tint alpha FALLS, which one opacity value cannot express |

| control | red | intact | what it is about |
| --- | --- | --- | --- |
| `no-blur` | **1** | 33 | only the standard deviation. **The page's own six proofs all stay green** |
| `no-glass` | 7 | 27 | `backdrop-filter: none` — the blunter cut, and it takes the remap with it |
| `sever` | 4 | 30 | a wrapper at `opacity:.99`. The strips still ask for blur(9px) |
| `no-halo` | 5 | 29 | the caption's glow goes; contrast collapses to 2.1:1 and 1.7:1 |
| `flat-desk` | 2 | 32 | constraint 50 as a world: no seam, so `blur(flat) == flat` |

**`no-blur` moving exactly one label is the milestone.** Nothing reachable from script can see that
a blur is gone — a `backdrop-filter` is applied by the compositor, `getImageData` reads a canvas,
and a DOM rasteriser applies no filter at all — so the geometry, the chain, the halo, the inert
buttons and the focus pair are all still correct in a world with flat glass. One assertion in the
whole suite can tell, and it is the one that reads a screenshot.

### What the controls found, and the worst of it was my own highlight

**`--negative flat-desk` found a defect in this check.** The SPREAD clause **held** over a flat
desktop, where with nothing to blur there is no ramp to find. The cause is `.aero-light`, the
viewport-anchored specular highlight: it is a `background-attachment: fixed` gradient, so it varies
horizontally across the sample band **on its own**, and that variation reads as a spread transition
with no backdrop involved. The highlight was satisfying the blur assertion.

The SPAN clause is what fired, so the harness was honest — but only because two clauses were written
where one looked sufficient. That is the whole case for the control: `--prove-failure` could never
have found it, because an assertion over a constant still inverts and still fires.

### And a second engine found two more, which is now three milestones in a row

`bench/m7-win/firefox.py --page m11`. CLAUDE.md says to do this before reporting a milestone done
because the Chrome-only suite has already cost M4a and M6; it cost M11 as well.

**The blur band was placed at a constant offset, and Firefox renders at dpr 1.** A 29 CSS px caption
holds about 7 text-free device rows either side of its glyphs at dpr 2 and only 3 at dpr 1, so a
band asking for 6 rows at `capRect.y + 4` overlapped the glyphs and the proof failed on an engine
where the glass was fine. The band's depth and position are both derived from the measured gap now.

**And chasing that found the asymmetry the placement rule encodes.** `bench/m11-glass/scan.py`
prints a concentration figure for every row of a caption:

| caption rows | concentration | |
| --- | --- | --- |
| 0–8 CSS | 0.077–0.097 | clean glass |
| 9–10 CSS | 0.137–0.171 | the glyph tops beginning to tell |
| 11–21 CSS | 0.48–0.95 | the glyphs |
| 22–27 CSS | 0.52–0.74 | **still contaminated, and worsening downward** |

The last row is the finding. The caption's `text-shadow` halo is a 10 px blur, so it spills ~10 CSS
px *below* the glyph box — past the caption's own bottom edge — and carries the glyphs' horizontal
structure with it. **The region below the text is inside the text**, and `textRect` is only the
glyph box, so a rule that treated it as the text's footprint would place the band there. The band
goes above the glyphs, and falls back below only when the upper gap cannot hold two rows.

**Proof 6 cannot be taken in headless Firefox, and now says so rather than just failing.**
`:focus-within` matches nothing in a document that has no focus, so both windows read inactive and
the pair cannot be compared. The clause still fails — a proof that cannot reach its subject must —
but it carries `documentHasFocus` so a reader is told which of the two happened. The suite drives
Chrome with focus emulation on and takes the measurement.

**Three more, each a real bug in work already written.** The Aero sheet never set
`position: absolute` on `.window` — `window.mjs` writes `left`/`top`/`width`/`height` inline and
never `position` — so the four strips resolved their own `bottom: 0` against the DESKTOP and the
ring measured 41,100 CSS px² against a formula of 26,780, with every window stacked at the top left.
The blur band, sampled at the caption's vertical middle, **crossed the title's glyphs**, whose edges
are hard steps: 0.74 against 0.078 for the same glass clear of them, which would have put the
threshold on the wrong side of the answer. And the page's log `<pre>` grew as the proofs ran, moving
the desktop down **between the moment every device rect was published and the moment the driver
photographed it** — so the driver sampled bands that were no longer there, and still produced
numbers.

### The defect a screenshot found, which no check could

**End Process was offered on every healthy window the moment the skin existed.** `.title-box`
carries `display: grid`, and an *author* `display` declaration beats the UA stylesheet's
`[hidden] { display: none }` — so M7's not-responding escape hatch was permanently visible, and a
wedged process was indistinguishable from an idle one.

**M7's own check could not see it.** `src/wm/window.mjs` sets the attribute correctly and M7
asserts on exactly that; M7's page is unskinned, so it asserts on a frame this rule never touched.
Found by looking at `bench/m11-glass/shell.py`'s screenshot of the real desktop. The m11 check reads
the *computed* style now, because the attribute was never the thing that was wrong.

### What the critic changed, and two of its eleven were fatal

**`src/wm/aero.mjs` did not parse, twice.** The stylesheet is a template literal, so a backtick in
one of its comments ends it — and the comment explaining the `[hidden]` fix above was written with
backticks around `hidden`. Nothing that imports the file loads, so the m11 check came out BROKEN
rather than failing, which is the harness behaving correctly. Every reference inside that literal
uses single quotes now, and the function says why.

**`DEVICE_SCALE` does not exist**, so `dpr = b.get("dpr") or DEVICE_SCALE` raised `NameError`
instead of falling back — reachable on any run where the page reports `done` with no blur evidence,
which `?live=1` does by construction. It is `VIEWPORT_SCALE`.

**`concentration` could come back negative, which satisfied the gate unconditionally.**
`max(jumps)` is signed, so a band whose luminance *falls* left-to-right produced a negative largest
jump and a negative concentration — and `concentration <= 0.35` passes for every negative number.
The discriminator stopped discriminating for half of all possible runs. It is `max(abs(j))`.

**The contrast figure was labelled WCAG and was not WCAG.** It fed gamma-encoded luma straight into
`(L1+0.05)/(L2+0.05)`, which is consistently generous: a glyph/halo pair at luma (128, 0) reads
11.0:1 that way and 5.3:1 correctly, and (255, 128) reads 2.6:1 against 1.8:1. Both straddle the 4.5
threshold, so the clause could have reported AA for a caption that does not meet AA. The channels
are linearized now, with the weight-then-linearize approximation named where it is made.

**And fixing it sharpened a control.** `--negative no-halo` used to move both legibility clauses;
with the correct arithmetic it moves only the WHITE side. White glyphs over the dark half of the
seam have real contrast on their own (6.0:1); over the bright half they have none (1.3:1). That
asymmetry *is* the argument for the glow, and the control now demonstrates the claim its label
makes rather than a stronger one.

**The inert-button clause could not fail.** `HTMLElement.click()` returns early for a disabled form
control, so `btn.click()` dispatched nothing and "the box did not move" was true however the buttons
behaved. It is a REAL mouse drag from each button's centre now — the gesture that can actually move
a window, and the one that tests whether the press falls through to the caption. Shown capable of
failing: with `pointer-events: none` on `.title-box` the drag from minimize moved the window from
`60,60` to `100,84`, exactly the drag vector.

**Four smaller ones, all real:** `proofFocus` dereferenced `second.id` before its own length guard,
so an empty window table arrived as a stack trace instead of the proof's evidence; a band that fitted
in neither caption gap fell through and could be placed inside the opaque client area while
`bandIsTextFree` still reported true, because the client area has no glyphs in it; `--negative
flat-desk`'s prose claimed the contrast collapses, which the measured tuple says it does not; and
`drive.py` could not reproduce the one control credited with finding a defect in the check.

### What is not done

**MINIMIZE AND MAXIMIZE DO NOTHING, and they say so.** They are drawn and `disabled`, which is
Windows 7's own rule for an inapplicable caption command: there is nothing to minimize INTO until
M14's taskbar, no snap state to maximize TO until M14's Aero Snap, and the window ABI carries no
state property at all — `WIN_SET_TITLE`, `WIN_SET_BOX`, `WIN_SET_MODAL` and nothing else. A check
clicks both and asserts the box did not move.

**THE AFTERGLOW IS FLAT.** Aero's second term is `luminance709(blurredRGB) * afterglowRGB`, and no
CSS layer can read the blurred backdrop's luminance: `backdrop-filter` yields one filtered copy and
a `plus-lighter` sibling sees a colour, never the pixels beneath it. So the afterglow and
colorization terms are summed into one additive constant — exact under that approximation, because
Windows 7 uses the same Sky colour for both. What is lost: glass over a bright backdrop should
afterglow more than glass over a dark one, and it does not. `src/wm/aero.mjs`'s `ADDITIVE_ALPHA`
carries the derivation.

**THE HIGHLIGHT IS PARALLAX 0.0, NOT 0.1.** Aero's streak is a monitor-space bitmap that moves 10%
of the window's own motion; `background-attachment: fixed` is fully monitor-anchored. Closing the
gap needs a style write per drag frame, which is not worth 10% of a highlight.

**FOUR FILTER PASSES PER WINDOW, UNMEASURED AT SCALE.** The ring's area saving costs four offscreen
buffers and four filter passes per window instead of one. gap-04 measured *area* as the predictor
and layer count as free up to 60 layers; four strips at 52 windows is 208, past anything measured.
**M12 owns this**, and it is the first thing its gate should look at — the governor's own arithmetic
is a sum over `aero.ringArea`, so a per-layer cost it does not model would be invisible to it.

**NO FRAME-RATE FIGURE IS TAKEN HERE.** The suite is headless on SwiftShader, where a frame time is
a number about the software rasteriser wearing the name of a number about Aero.
`bench/m11-glass/probe.py --headed` exists for that reason and M12's gate must use it.

**NO TASKBAR, NO START ORB, NO SNAP, AND NO ICONS.** All M14, and the icon and font redraw is its
own line. Segoe UI is referenced and never served (constraint 37); Selawik is named for the same
reason. **Constraint 37 requires every layout to be measured against both, and that cannot be done
here** — Segoe UI cannot legally be obtained for the comparison — so nothing in the skin depends on
a glyph advance: the caption truncates, the buttons are fixed boxes, and the terminal cell is still
measured from a real rendered glyph.

**THE RESKIN IS ONE PAGE DEEP.** `www/m11.html` installs the skin; the eight older `www/*.html`
pages keep their structural stylesheets, which is deliberate — their checks drive an *unskinned*
frame, and the strips are out of flow and zero-sized without the Aero sheet, so M7–M10 run
unchanged. `desktop.mjs`, `dialogs.mjs`, `widgets.mjs` and `contextmenu.mjs`, which `PLAN.md` §5
lists as part of this reskin, **do not exist in this repository** — they are webxp files, and there
is nothing here yet for them to be a skin of.

---

## M12 — the blur governor · done · 0.5 days · ~1,900 LoC

An admission controller over total blurred area, in `src/kernel/wins.mjs`: it runs on every event
that can change the area — a window opening, the page reporting a box after a clamp or a resize, a
window being destroyed — and when the total crosses the budget it takes glass from the **bottom of
the stack** upward. `src/abi.mjs` gained the chrome metrics and the area function, because the
moment the kernel accounts a border box the ring's geometry stops being the skin's private
business. `www/m12.html` is four proofs and a live desktop; `bench/m12-governor/` is the sweep and
the host probe.

### The gate the plan specifies cannot fire, and that is the finding

`PLAN.md` §5 and constraint 49 both size M12's kill gate at **"52 glass terminals at 640×440
(53.7 M device px)"**. That is *box* accounting — one filtered node per window. M11 shipped the
ring, four filtered strips summing to 27,260 CSS px² per window, so:

| | per window, dpr 2 | 52 windows | windows to the 45 M budget |
| --- | --- | --- | --- |
| one glass node (what the gate assumed) | 1,126,400 device px | 58.6 M — **over** | 40 |
| four strips (what M11 shipped) | 109,040 device px | 5.7 M — **10% of it** | **413** |

Reaching the budget needs 413 windows of 640×440 against `WIN_CAP` 32 per process. **A gate that
needs 413 windows cannot fail** — which is the exact defect constraint 49 was itself corrected for
once already (`docs/DECISIONS.md` §Corrections: the 4× dpr error that made the Aero gate
structurally green). Twice is a pattern, and the pattern is sizing a gate from an arithmetic rather
than from a run.

So the finding is **asserted rather than written down**: proof 1's last clause is that at the
shipped budget this desktop is entirely glass, and the degrade branch is driven at a budget the
page *measured* off the windows on screen.

### What the sweep answered, and it answers M11's owed question

`bench/m12-governor/probe.py` separates two axes gap-04 varied together. At a **fixed** 5.7 M
device px of filtered area, changing only how many filtered boxes it is spread across:

| filtered boxes | fps |
| --- | --- |
| 52 | 29.3 |
| 104 | 30.0 |
| 208 | 28.0 |
| 832 | 13.8 |
| 1664 | 8.4 |

**Pass count is free to ~208 and costs beyond ~800.** M11 recorded "four strips at 52 windows is
208 passes, past anything measured" as owed; it is measured now, and four strips per window costs
nothing at any window count the caps allow. gap-04's "the predictor is area, not layer count" holds
with its range extended.

The harness validates against gap-04 twice: the box geometry walls where gap-04 said it does, and
the 20 ms main-thread stall control reads **49.2 fps against gap-04's 49.3**.

### And no frame-rate gate is obtainable in this environment

`PLAN.md` asks M12 to "assert that frame rate holds ≥ 110 fps". It cannot be measured here, and the
honest thing is to say so rather than print a number:

- **Headless** pins to **60.0 fps** on SwiftShader with `--disable-gpu`. gap-04's whole Aero budget
  was taken at 120 Hz on a real GPU, and constraint 36 itself notes a 60 Hz panel has twice the
  per-frame budget. A frame time from here is a number about a software rasteriser wearing the name
  of a number about Aero.
- **Headed through CDP** is throttled to **8.9 fps** — Chrome will not paint a window it believes
  occluded, and `Page.bringToFront` hangs on a window nothing can focus. The flags that keep a
  background window live get frames but not representative ones.

`bench/m12-governor/probe.py --headed` is where that question lives, and it **refuses to draw a
conclusion** rather than printing one: every row is labelled with its engine, and the verdict says
"no row here is a number about Aero" unless it ran headed. The frame-rate half of M12's gate is
recorded as unmeasurable with its reason, and the measurable half — the accounting, the order, both
edges, and whether the blur actually went — is what the suite gates on.

### The four proofs, and what each control moved

| | proof | what it asserts |
| --- | --- | --- |
| 1 | the accounting | the kernel's per-window cost equals what the RENDERED strips cover, the page reported its dpr, and the shipped budget is out of reach |
| 2 | the degrade branch | over the budget glass comes off, from the bottom of the stack in stack order, the top keeps its glass, the total lands under the budget, and the page rendered exactly the set the kernel decided |
| 3 | it settles, and recovers | the two edges exist and are ordered, re-running over an unchanged desktop changes nothing *and the governor was really re-entered*, and closing windows gives the glass back |
| 4 | the pixels | a flattened window carries **no** backdrop-filter, and its caption reads as a STEP across a hard seam where a glass one reads as a spread ramp |

| control | red | intact | what it is about |
| --- | --- | --- | --- |
| `no-governor` | 9 | 18 | `PLAN.md`'s own: nothing is ever flattened. Every **measurement** holds |
| `top-first` | 4 | 23 | degrade from the TOP. Moves the ORDER clauses and nothing else |
| `stale-costs` | 3 | 24 | admission reads the post-degrade total: the feedback loop, restored |

**`top-first` is the one worth having.** It moves four labels and leaves twenty-three — glass still
comes off, the total still lands under the budget, both edges still work, a flat caption is still
there to sample. What changed is *which window pays*, which is the half of constraint 49 that is a
judgement rather than an arithmetic, and the only half a correct-looking implementation can get
backwards while every number stays right.

### Proof 4 was unsound twice, and a screenshot is what showed it

**A window's backdrop is the window beneath it.** `winopen` cascades, so each caption sits over the
*opaque client area* of the window below — and a `backdrop-filter` filters what is behind the
element. Both sampled bands came back uniform (span 0.86 luma) because they were reading white
plastic, and the proof failed for a reason that had nothing to do with the governor. The fix is
staging: two windows only, stacked vertically rather than cascaded, both straddling one seam, with
bare desktop behind each caption and the budget armed at one window's cost so the bottom is flat and
the top is glass — by construction rather than by luck. The move is the arrow-key gesture's own
route, so the kernel learns the geometry exactly as it would from a user.

**And the reference band was sampling the wrong element.** "20 device px above the desk's bottom
edge" landed below the seam, on the Aero desktop's own gradient, which is uniform — so the
"the seam is real" clause failed at span 0.0 while the seam was perfectly fine. It is found by
`elementFromPoint` now: the page asks the browser what is actually there.

### What a second engine found, which is now four milestones running

`bench/m7-win/firefox.py --page m12`. **413 is a dpr-2 constant**, and headless Firefox renders at
dpr 1 where the same geometry needs 1,651 windows — so an assertion on 413 failed on an engine whose
governor was fine. The same class of defect M11 shipped and the same lesson: a figure derived from a
measured ratio survives a second engine, a constant does not. The claim is now a floor — more
windows than `PROC_CAP` allows one each, so no desktop gets there — and the exact dpr-2 figure is
asserted in `bench/m12-governor/probe.mjs`, where the ratio is fixed.

### The defect typing it found, which no check could

**The live desktop's governor never fired.** `bootHost` stopped setting the budget when the proofs
moved to arming one they measure, and nothing re-armed it in `live()` — so the desktop ran at the
shipped 45 M budget, 413 windows away, while the page's own log told the reader to type
`winopen -n 4` and watch the bottom windows lose their glass. They did not.

No check could have caught it: the proofs arm their own budget and pass, and the live path has no
assertions. What caught it was typing the command. `bench/m12-governor/shell.py` is that run, and it
then found a second one — the budget was armed at "four terminals' worth", a terminal is 560×360
and `winopen` asks for 420×260, so four of the smaller windows fitted a four-terminal budget and
five windows still showed no degrade. It is armed relative to what is on screen now.

### What the critic changed, and one of eleven was the governor's own accounting

**The accounting made the input respond to the action.** `governBlur` summed the ring area of the
windows that still had glass, so flattening one lowered the total, which re-admitted it, which
raised the total again. That is a genuine feedback loop, and it had two faces:

- **It was not idempotent.** Re-running it over an unchanged desktop could change the flat set.
- **And it had a stuck state.** Gating re-admission on a restore edge below the budget means a
  single window whose own cost exceeds that edge can never recover its glass, because `0 + c` is
  always more than `0.8 × c`. Hit twice — three captions staying flat after four windows closed,
  then both staged windows flat because neither fitted under the lower edge.

The fix is to sum the **all-glass** cost, which no action changes. The keep-set became a pure
function of (stack, costs, budget), the governor settles in one pass, and **the hysteresis stopped
being load-bearing** — with an action-independent input the band between the two edges cannot change
which windows are flat. Recorded as constraint 269, because the general form is worth having: the
loop was the defect, not the absence of damping.

**So `--negative no-hysteresis` was replaced.** Against the corrected accounting it broke nothing at
all, and a control that cannot fail is worse than no control. `--negative stale-costs` restores the
loop instead and is the defect that is really there: the degrade counter climbs over a desktop
nobody touched.

**A RAISE NEVER RE-ADMITTED.** The governor ran on create, on the geometry report and on destroy —
every event that changes the area, which is what constraint 49 asks for — and not on a raise, which
changes only the order. A window clicked to the front stayed flat while one now beneath it kept its
glass, which is `--negative top-first`'s own outcome reachable with no control on. Recomputing the
keep-set from the top of the stack fixes it structurally; the old version walked its own previous
flags and could not express a swap. Constraint 270.

**And proof 3's "it settles" clause never re-ran the governor.** It nudged a window with
`Win.moveBy`, which writes the box and calls `apply()` — but the *kernel* learns a box from
`WinHost.#report`, wired to `pointerup` on the frame and `keyup` on the title bar. No `win-geom`
was posted, `governBlur` was never called, and the clause asserted that a function nobody ran had
changed nothing. It dispatches the keyup now, and asserts the page's own geometry counter moved, so
a run where the keystrokes reach nothing fails instead of passing.

**Seven smaller ones, all real:** `DEVICE_SCALE` again, this time as `noBlurFlat` reading `all()`
over an empty generator — so a sweep whose blur-off rows both timed out reported the control as
holding with no frame measured; `stallFired` using `or 999`, so a measured 0.0 fps read as "did not
fire", which is the one result that row most wants to report; `win-dpr` missing from the pre-boot
guard, where it would panic the kernel instead of being told what it did wrong; a `bornFlat` toggle
that could only ever be a no-op, since winids are monotonic and `win-create` precedes the
`win-blur` that follows it; a flat window losing the active/inactive cue entirely, because
`is-flat` replaced both the strip brightness and the sheen that carried it; an accounting tolerance
that scaled with the window count, so one window's cost could be wrong by 48 device px once six
were open; and a citation of `--negative blur-tiny`, which does not exist.

### What is not done

**THE GOVERNOR DOES NOT FIRE IN NORMAL USE**, and that is a property of M11's geometry rather than
of this threshold. A realistic ten-window desktop is 1.09 M device px — 2% of the budget. The
admission controller is correct, armed, and demonstrably working when driven to its branch; it is
also, on the shipped geometry, a cap for a case nobody reaches. The same is true of
`SURFACE_BUDGET_PX`, which is why that is the shape it was built in.

**MINIMIZE, SNAP AND PEEK ARE NOT AMONG THE EVENTS IT SEES**, because they do not exist yet.
Constraint 49 lists "open, maximize, snap, restore, un-minimize, peek"; in this codebase every one
of those is either a create, a destroy, or the page reporting a box, and the governor hangs off all
three. M14 adds the gestures, and they arrive as box reports — but **nothing has yet driven a
minimize through it**, so the claim that the list is covered rests on the shape of the ABI rather
than on a run.

**THE PASS-COUNT CEILING IS NOT GOVERNED.** The sweep found filtered boxes free to ~208 and costly
beyond ~800, and nothing accounts them: 200 windows would be 800 passes. It is unreachable for the
same reason the area budget is, and it is recorded here rather than guarded.

**THE BUDGET IS ONE MACHINE'S.** 45 M off / 36 M on derive from gap-04's 58–63 M wall, measured on
one 120 Hz panel at dpr 2 with one GPU. An integrated GPU has far less and a 60 Hz panel twice the
per-frame budget. Nothing adapts the budget to the machine, and doing so would need the frame-rate
measurement this environment cannot take.

---

## M13 — the geometry harness · done · 0.5 days · 780 lines of page and protocol

The only proof M7–M12 have that the numbers they trade are about the window a reader can touch.
`www/m13.html` is seven proofs over the clamp, the gestures, the kernel's record, the glass ring,
the stack, a desktop that changes size and the minimum size; `scripts/check.py`'s `check_m13` reads
them and drives every gesture with a real pointer and real keys.

### The page asks and the check performs, which is a protocol rather than a convention

A page cannot drive its own pointer. A synthesised `PointerEvent` carries `isTrusted === false`,
and `setPointerCapture` refuses a pointerId no live pointer owns (constraint 175) — so a window
manager driven by the page under test is a window manager nobody has moved. `gestureAsker`
(`www/pagekernel.mjs`) publishes the gesture a page needs at coordinates it measures off its own
rects and blocks until something performs it; `drive_gestures` (`scripts/check.py`) is the other
half and uses `Input.dispatchMouseEvent`. **A human reading the page performs the same asks by
hand**, which is what the bench shells have always done. One definition of the handshake, because
two sides agreeing about it by hand is how a page comes to wait for a gesture nobody is sending.

### The three edges of the clamp are three different gestures, and that is arithmetic

The right and bottom bounds sit INSIDE the desktop, so a pointer can overshoot them without leaving
the viewport. The top bound is reachable the same way. **The left bound is not**: it is
`MIN_VISIBLE - w`, which for a 420 px window is 348 px of window off the left edge, and a pointer
would have to travel to a negative client coordinate. The keyboard route — `#barKey`, `moveBy`,
`apply`, the host's `keyup` report — reaches it with real trusted keys, which is why
`src/wm/window.mjs` gives every gesture a keyboard spelling.

### What M13 found in the product, which is what a harness is for

**A desktop that changed size re-clamped nothing.** `Win.apply` clamps against the desktop's
CURRENT rect, so the clamp was correct at every gesture and stale at every resize: a desktop that
shrank left frames hanging outside it with their captions out of reach, and the kernel was never
told the boxes had stopped being true. `WinHost.relayout` and a `ResizeObserver` are M13's own
addition; `--negative no-relayout` is the world without them. M14 needed the same callback
immediately, for something that is not a resize at all — the taskbar takes a strip off the bottom,
so the WORK AREA changes when the shell appears.

### The seven proofs, and what each control moved

| | proof | what it asserts |
| --- | --- | --- |
| 1 | the clamp | dragged past the bottom-right corner, dragged above the top and arrow-keyed off the left edge, the frame stops at the bound — and in every clamped state a grabbable strip of caption is still over the desktop, measured on the RENDERED caption |
| 2 | the gesture | an unclamped drag moves the frame by exactly the pointer's delta, a drag after a clamped one starts from where the frame IS, and both ends of the keyboard step move |
| 3 | the kernel's record | the kernel's box is the box the clamp settled on, and its cell grid is what the rendered client area divides into |
| 4 | the ring and the chrome | the four glass strips do not overlap and their rendered areas sum to `blurRingArea`, which is what makes M12's accounting a fact about the product |
| 5 | the stack | a real click on a buried window's sliver raises it, and the window under that same point afterwards is the one that came up |
| 6 | the resize | a desktop that shrinks pulls every frame back inside it AND tells the kernel; one that grows back returns each window to the box it asked for |
| 7 | the floor | a box under the minimum is floored on screen, and the kernel records the floor rather than the request |

| control | red | intact | what it is about |
| --- | --- | --- | --- |
| `no-clamp` | 11 | 27 | a frame can be dragged out of reach — and the MIN_W/MIN_H floor goes with it, because `clampBox` is where that floor lives |
| `stale-geom` | 7 | 31 | the host reports the box that was ASKED for, so the kernel's whole record is a geometry no frame ever had |
| `no-relayout` | 5 | 33 | a desktop that shrinks leaves its frames outside it |

### A control found a clause that could not fail, and that is the run worth keeping

`--negative stale-geom` came out **green** the first time: proof 3 read the kernel's box against the
page's `placed`, and with every window inside the desktop `box` and `placed` hold the same numbers
— so a host reporting the REQUESTED box reported an identical number and the clause about exactly
that could not move. The fixture is now asked for a position far outside the desktop and
`fixtureIsClamped` is part of the clause, so a future desktop large enough to hold that request
fails the proof instead of passing it vacuously. **Inversion could not have found this**: the
clause inverted and fired, because it was an assertion over two copies of one number.

---

## M14 — Aero Snap, the Superbar, jump lists, the tray and the desktop · done · 1 day · 3,870 lines of shell, page and bench

The last row of the window half, and the one a reader sees: `src/wm/taskbar.mjs` is the Superbar,
its thumbnails, its jump lists, the start menu and the tray; `src/wm/desktop.mjs` is the icon view
and every mouse action on it; `src/wm/icons.mjs` is eleven redrawn icons; `src/bin/desktop.mjs` is
the process behind the desktop and the menu. The ABI gained a show state, a role and an item list.

A further 3,400 lines are SHARED between the two milestones and are counted in neither: the ABI's
new integers and codec, the kernel's state machine, the frame's snap and grips, the host's work
area and the checks for all of it. The split is where the files are rather than where the work was.

### Where the shell lives, and why that is a conclusion rather than a shortcut

`docs/research/09-hobbyist-os-actions.md` §4 records that a taskbar needs cross-process window
enumeration no ordinary client may have, and that SerenityOS answers it with a SECOND, separately
gated management endpoint. **This project needs no such endpoint, and the reason is specific to its
architecture**: the page already holds every window's frame — `win-create` built it, `win-stack`
ordered it, `win-title` named it — so a taskbar rendered by the page reads facts the page was
already told and adds no capability to anything. A taskbar as a PROCESS would need the endpoint.

And a process could not draw one anyway, which is the arithmetic half of the same decision: the
display list has no text op and no image op (`src/abi.mjs` `DL_*`), and a `WEV_POINTER` is only
delivered while a button is down — so a process-drawn Superbar could have neither labels nor hover,
and a rubber band is not expressible as a stream of filled rectangles. Recorded as **D39** and
constraint 275.

**What keeps it honest is `win_items`.** A window publishes rows, each flagged for where it appears
— `WITEM_DESKTOP | WITEM_MENU | WITEM_JUMP` — and activation comes back as `WEV_ITEM` carrying an
INDEX the kernel validates against the list it holds. So the desktop's icons and the start menu are
a process reading the filesystem: `src/bin/desktop.mjs` lists `/usr/bin` and `/desktop` and
publishes what it found. `--negative no-items` is the world where the kernel accepts those rows and
discards them, and it exists because **a page drawing a hard-coded list of programs would look
identical** without it.

### M12's own open item, closed by a run

M12 recorded: "MINIMIZE, SNAP AND PEEK ARE NOT AMONG THE EVENTS IT SEES, because they do not exist
yet… **nothing has yet driven a minimize through it**, so the claim that the list is covered rests
on the shape of the ABI rather than on a run." Proof 3 is that run. A minimized window's ring cost
goes to zero — `blurCost` charges nothing for a window with no frame on screen, which is also true
of the desktop — and the governor's input drops by exactly that window's ring, asserted as an
equality rather than as a direction (constraint 274).

### Both edges of both thresholds, because they are two different measurements

`PLAN.md` §5 names three numbers: snap arms at 1 px of pointer-to-edge, releases at 20 px of
drag-out, and 50 px of side-move restores a top-maximized window. All three are here, and the two
RELEASES are measured differently on purpose: a snapped window releases on total distance, a
maximized one on HORIZONTAL distance alone — its caption is at the top of the work area, so a user
reaching for it drags downward constantly and a total-distance rule would un-maximize on every
brush. Both edges of both are driven with a real pointer: 19 px holds, 21 px releases, 49 px holds,
51 px releases. Constraint 273.

### The nine proofs, and what each control moved

| | proof | what it asserts |
| --- | --- | --- |
| 1 | snap | the ghost promises the box the window takes, a release at the edge snaps to the half, 19 px holds and 21 px releases, a drag to the top maximizes, 49 px holds and 51 px releases |
| 2 | the work area | the strip the shell reserved is the strip the bar occupies, a maximized frame stops at the bar, and the kernel records it |
| 3 | minimize | the frame leaves the screen, the window is charged no blurred area, the governor's input drops by exactly its ring, and its taskbar button stays |
| 4 | the Superbar | two windows of one program are one button, a real click raises the group, and a second click on the front group lists its windows |
| 5 | the jump list | the rows on screen are the rows a program published, plus the shell's own Close — and a real click on one reaches the program, which opens a window |
| 6 | the icons | the icons drawn are the rows the process published, the start menu is a listing of `/usr/bin`, and a real double-click starts the program a row names |
| 7 | every mouse action | a rubber band selects what it touches, a modifier-click adds to the selection, a drag moves an icon, and it stays there across a redraw |
| 8 | the tray | the clock advances, hovering Show desktop peeks and changes no state, a click minimizes everything while the desktop stays, and a second click puts it all back |
| 9 | the glass | the taskbar's own band reads as a spread ramp across a hard seam, where the bare backdrop reads as a step |

| control | red | intact | what it is about |
| --- | --- | --- | --- |
| `no-snap-hysteresis` | 4 | 47 | `PLAN.md`'s own: the release collapses onto the arm, so both HOLD clauses go and both releases still work |
| `no-workarea` | 6 | 45 | a maximized window covers the taskbar, and the kernel records the full height |
| `no-group` | 4 | 47 | one button per window, which is the pre-Windows-7 bar: the grouping goes and the window list with it |
| `no-items` | 13 | 38 | every published row is discarded, so the desktop, the menu and the jump list have nothing to show |

### What four runs found, and every one of them was a defect rather than a flaky check

1. **`TextDecoder` refuses a view onto a SharedArrayBuffer.** The first `win_items` carrying a
   label threw inside the kernel, `handle()` turned it into a PANIC, and every syscall after it
   answered -EIO — so the desktop process reported `win_items: EIO` and a `/usr/bin: ENOENT` from
   the same cascade. `readTitle` had always copied for this reason; the item path did not. The
   kernel copies the region once and `decodeWinItems` slices each label, so the codec is safe on
   either side of the channel.
2. **Every gesture went to the wrong window.** The snap proof grabbed a caption at coordinates
   computed off the right window's rect — and another window was ON TOP of that point, so the drag
   moved the terminal while the proof measured the window it meant to drag. Nothing failed loudly:
   the subject simply never moved. Gestures are hit-tested with `elementFromPoint` now and the hit
   test is part of the clause.
3. **The desktop has no taskbar button, so a jump list could not be opened on it.** It is the
   surface the buttons sit on. `src/bin/winopen.mjs` publishes a jump list instead — "New window"
   really opens one — which is both what the feature is for and the only way to reach one.
4. **On macOS a Ctrl-click IS the secondary click.** `modifiers: 2` arrived as a right button and
   opened a context menu instead of extending the selection, and the selection came back empty.
   The gesture uses Meta, which `src/wm/desktop.mjs` already accepts beside Ctrl and which is what
   a Mac user's hand does.

A fifth was a race rather than a defect: the pointer is on a taskbar button when a right-click
lands, so the thumbnail timer was already running and replaced the jump list 120 ms later. A
deliberately opened menu cancels a pending hover now, and the proof hovers first on purpose so the
precedence is what is being asserted.

### And then the probe corrected a hypothesis it was written to confirm

Two of those cost a run each because a DRIVEN gesture is not the gesture a hand makes, so
`bench/m14-shell/input-probe.py` records every DOM event `Input.dispatchMouseEvent` really
delivers. It found that **a right press DOES deliver `contextmenu`** — the opposite of what was
assumed from `jumpOpens: 0` — and that the jump list's real defect was in the DRIVER, which sent a
left button for a gesture named `rightclick`. A left click on a taskbar button is a perfectly good
gesture that does something else, so nothing looked broken. **The measurement is what separated
"the browser does not deliver this" from "we never sent it"**, which is a distinction a harness
cannot make by reasoning (constraint 279).

It also found the two that were already fixed by then, and both for better reasons than the guesses
they replaced: a pointer capture retargets `click` and `dblclick` to the CAPTURING element, and on
macOS a Ctrl-click is the secondary click — it delivers `contextmenu` and no `click` at all.

### What LOOKING AT IT found, which is now five milestones running

`bench/m14-shell/shell.py` boots the live desktop, types at the shell, snaps a window with a real
drag, opens a menu and photographs the result. Three things only a picture showed:

1. **THE DESKTOP HAD NO ICONS IN THE PICTURE** — and they were there the whole time, behind the
   terminal. The icon column is at the desktop's left edge, which is exactly where a fresh window
   opens. The harness parks the windows before the shot now, which is what a reader does with their
   hand, and the m14 check's own `clearTheIcons` does the same before its icon proofs.
2. **A JUMP LIST TITLED `term.mjs`, WITH A GENERIC ICON.** A program started from `/usr/bin` is
   `term` and one the page spawned by URL is `/src/bin/term.mjs` — `src/kernel/providerfs.mjs`
   drops the extension from a mount name on purpose, so the two spellings of one program reached
   the shell differently and the icon table matched neither. `progName` strips the extension, and
   it and the icon table moved into `src/wm/icons.mjs` for a second reason:
3. **A WINDOW'S CAPTION HAD NO ICON.** Windows 7 draws the program's icon at the left of every
   caption, and the bar draws the same one — which is why the table cannot live in the taskbar.
   `Win.setIconMarkup` is the frame's half, and the host fills it from the program the KERNEL
   named, because the page cannot learn what a pid is running.

A fourth was a gap rather than a defect: `term` published no jump list, so a right-click on the one
button a fresh desktop has said "This program published no tasks". It publishes "New terminal" now
— Windows 7's own first row for most programs, and a thing the program that owns a window, a pty
and a shell can really do.

### And a second engine, which is the fifth milestone running — but this time it found nothing

`bench/m7-win/firefox.py --page m14 --live`. Headless Firefox rendered the shell, the frames, the
caption icons, the Superbar and the tray **and showed no desktop icons** — which is exactly the
shape of the four engine defects this rule exists for, and it was not one.

Mozilla removed CDP, so a PNG is the only channel: the page prints its own log for that reason, and
what it printed settled it. `desktop: win 1, 26 rows published, 4 icons drawn` ruled out the
process and the view; `icon 1 92x77 at 16,156` and `icon svg: 48x48 at 38,161, 6 children, 2
gradient(s)` ruled out the layout and the gradients — and then named the cause, because the
terminal window was at `8,148` and 639 px wide. **The icons were behind it, in both engines**, and
the first two Chrome screenshots had the same thing wrong with them.

So the finding is about the product rather than about Firefox: **the live desktop opened its one
window on top of its own icons**. It opens clear of the icon column now, which is what a first-run
desktop owes a reader — and the diagnostic lines stayed in the page, because they are what turned
an invisible desktop into a located one in a single run.

### What the critic changed, and the worst of it was a restore point that outlived its use

Eight findings, all eight verified against the code before anything was touched, all eight real.

**A RESTORE POINT SURVIVED THE RETURN IT PAID FOR.** `setState` wrote `win.restore` on the way out
of a floating state and never cleared it, and the page applies whatever box the post carries — so:
maximize a window at (30,40), restore it, DRAG it to (500,300), minimize it, then click its taskbar
button. The post carried (30,40), the window teleported there, and because the page reports the box
it settled on, **the kernel then recorded the wrong place too**. The same line fired mid-drag:
`#undock` anchors the frame under the pointer and then asks for NORMAL, so the answering `win-show`
moved the window out from under the hand holding it. The box now travels with the post that uses it
and is cleared behind it, and a drag that placed the frame itself says so (`pendingUndock`).

**A MINIMIZED WINDOW THAT TOOK THE DESKTOP ROLE BECAME PERMANENTLY INVISIBLE.** `setRole` forced
the state to NORMAL and posted only `win-role` — but the page writes `Win.state` only from a
`win-show`, so the frame kept `hidden` set while the kernel believed the desktop was normal and at
the bottom of the stack. And `setState` refuses a desktop, so there was no way back. It was the
exact state that code's own comment claimed to be preventing.

**ONE LONG FILENAME BLANKED THE WHOLE DESKTOP.** `src/abi.mjs` says in as many words that the
publisher truncates — "a refusal would make a long filename unpublishable" — and
`src/bin/desktop.mjs` did not: a 65-byte name in `/desktop`, or 45 files in it, made
`encodeWinItems` return null and EVERY row disappear, because the list is published whole. Worse,
`rows` was replaced before the publish was attempted, so a refused publish left the kernel holding
the old list while the process held the new one — and a `WEV_ITEM` index the kernel validated
against the old list was looked up in the new array and would have launched the wrong row. Labels
are truncated with an ellipsis, the list is capped and the cut is REPORTED, and the process's array
is committed only once `win_items` has accepted it.

**AND FIVE MORE, every one of them a thing a reader could reach.** `Taskbar.dispose` removed its
elements and left its watcher registered and its 40 px reserved, so a disposed shell kept rebuilding
buttons in a detached band while every maximized window was laid out against a strip reserved for
nothing — in the method whose docstring says it exists for that case. Giving the desktop role BACK
buried the window and left it with an icon view and no keyboard, so the role is one-way now, which
is `win_surface`'s own rule rather than a new one. The right snap edge armed over two pixels where
the left and top arm over one, in a function whose comment says the figure "is not a tolerance to be
widened". A taskbar group's key is the basename of ARGV[0] — a program's own string — and it was
interpolated into a `querySelector`, so a quote in an argv threw a SyntaxError inside a click
handler. And `onLaunch` was dead: read from the spec, stored, never called, and still described in
the constructor's docstring as how a start-menu row runs a program.

**Three of the eight became checks**, which is where a confirmed finding belongs:
`bench/m14-shell/probe.mjs` is 60 host checks now, and the new ones drive the restore point through
maximize-restore-move-minimize-restore, assert the `win-show` a minimized window gets when it takes
the role, and assert the role is refused in reverse. The other five are page-side (a pointer, a DOM,
a disposed shell) and are recorded here rather than asserted.

**AND ONE MORE THING THE FIXING FOUND, which is not in the critic's list.** Two of the eight were
applied by a patch script whose `str.replace` matched nothing — a silent no-op — and the host probe
caught it: the new clause for the role fix failed with `<no post>` against a kernel that had never
been changed. A patch that cannot fail is a patch nobody has checked, which is this project's own
rule about harnesses pointed at itself.

### What the runs themselves did, including the two that were not about M14

Two anomalies came up while verifying this milestone, and both are hazards this repository already
names — recorded because a suite's own flakes are evidence about the suite.

**The worker-startup stall hit twice, on two different checks.** `m7` FAILED at 78 s where it takes 18, with empty event evidence:
both windows created, the banner printed, the process parked in `poll` and then sitting in
`waitpid`, and no result ever delivered. It passes alone, immediately, every time. And on a later
run `m0` came out BROKEN in 0.65 s with `kernel worker: undefined`, which is constraint 207 in its
own words — "a Worker that will not start fires an error event with an EMPTY message" — on a page
that predates the boot retry `www/pagekernel.mjs` added for exactly this. Neither is something M14
touched: `m7`'s page has no shell, no items and no show state, and `m0` does not load `src/wm` at
all. Both are about a machine that has been starting and killing Chrome for an hour. Re-run alone,
`m0` reports its 31 expectations in 1.79 s.

**And one control run came out BROKEN on a dropped CDP socket**: "connection closed mid-frame",
after five Chrome sessions had been started and killed back to back. `CLAUDE.md` names this one
too — "kill stray Chrome between control runs… a twelve-control sweep without it reported
`patched-optional` BROKEN, and the same control passed alone". It scored 15 red and 38 intact on a
clean run, exactly as declared.

**Neither was treated as a pass.** A flake that is explained is still a run that did not measure
what it claimed, which is why both were re-run rather than argued away — and why the figures quoted
above are from runs that measured.

### Three more the pictures asked for, after the critic

**THE WINDOW MENU, which is a mouse action a frame did not have.** A right-click on a caption shows
Restore / Minimize / Maximize / Close in Windows 7, and the rows here are the same state asks the
caption buttons make — deliberately nothing more, because a menu that could do MORE than the
buttons would be a second authority on a window's state. A row that does not apply is drawn and
DISABLED, which is this project's own rule for an inapplicable command. The frame hands the gesture
UP rather than drawing it: the shell owns every menu (**D39**), so `Win.onMenu` reaches
`WinHost.useShell`'s shell or nothing happens — a page with frames and no taskbar gets no menu
rather than a broken one, which is M7 through M13.

**THE START MENU HAS TWO COLUMNS, which is one list rendered a fourth time.** Windows 7's right
column is places, and the rows the desktop published for ITSELF — Computer, the folders, a terminal
— are exactly that. `WITEM_*` being FLAGS rather than an enum is what makes it free: the same row
is a desktop icon, a start-menu program, a jump-list command and now a place, and adding the
rendering was adding a filter rather than editing anything.

**AND A SCREENSHOT CAUGHT THE MENU BEING UNREADABLE.** Its fill is translucent, so the desktop's
own icon LABELS read straight through the rows — two legible texts on top of each other, which is
neither. Windows 7's menu is blurred glass, and blurring is what makes a translucent panel legible
at all: constraint 34's argument applied to a menu rather than to a frame. It is a filtered box the
blur governor does not account, like the taskbar, and bounded the same way — at most one popup
exists at a time.

### What is not done

**THE NEW SURFACES' CONTRAST IS STRUCTURAL, NOT SAMPLED.** M11 samples the caption's legibility out
of real pixels at both ends of a seam. M14 added three more places where text sits over an unknown
backdrop — a desktop icon's label over wallpaper, a taskbar button's label over glass, a popup row
over a dark sheet — and each carries the same halo the caption does, but nothing measures the
contrast ratio at those positions. The `PLAN.md` icons row asks for exactly that re-check.

**THE SHELL'S OWN BLURRED AREA IS NOT GOVERNED.** The taskbar is one `aero-strip` and a popup is
another, and M12's admission controller accounts neither: the governor sums WINDOW rings. At
1,264×40 CSS px the bar is about 202,000 device px at dpr 2 — a fifth of one window's ring — and a
menu is at most one more. Both are bounded and constant, which is why this is recorded rather than
guarded; a shell that grew a panel per window would not be.

**A TEXT WINDOW'S THUMBNAIL IS A READING, NOT A PICTURE.** A surfaced window's preview is its own
canvas, drawn exactly. A text window is a DOM widget and there is no way to rasterise one from
script, so its preview is the last nine lines of its screen drawn small. Windows 7 gets a real DWM
thumbnail; this is the honest approximation and it is labelled as one in the code.

**NOTHING IS PERSISTED.** A dragged icon keeps its cell for as long as the view lives, pinned
taskbar buttons do not exist, and the start menu has no recently-used list — all three need a place
to write preferences, which is a decision about where user state lives rather than a shell feature.

**THE DESKTOP IS NOT WATCHED.** There is no inotify in this ABI, so the desktop re-reads the
filesystem when a reader asks — the start menu's "Refresh the desktop" row — and not when something
changes underneath it.

**MINIMIZE HAS NO ANIMATION AND PEEK HAS NO THUMBNAIL OF THE DESKTOP.** Windows 7 animates a window
into its button and Aero Peek fades the frames out; both are opacity or transform animations on a
window wrapper, which is exactly what severs the blur chain for everything inside it
(`docs/designs/REVIEW-FINDINGS.md` §8). Peek is implemented as the strips and client areas going to
zero opacity, which leaves the frame's outline and does not touch the chain — the animation is not
worth the risk and is recorded here instead.

---

## Ordering corrections in the window half

Two from `docs/research/09-hobbyist-os-actions.md`, both of which reverse or tighten what
`PLAN.md` §5 currently implies.

**M8 gates M12, not the other way round.** The blur governor cannot account what it did not
allocate. So the surface-ownership decision — kernel-allocated retained surfaces versus M8's
transferred `OffscreenCanvas` — has to be made *before* the governor, because only
server-allocated surfaces give **accounting and revocation**, which constraint 49's admission
controller and constraint 17's cap both need and neither currently has.

A transfer is also one-way and one-shot: the process loses the object, so there is **no front/back
pair and no cheap flip**. Haiku's server allocates bitmap memory and maps it to the client;
SerenityOS has the client allocate both stores and hand over an fd with a monotonic serial, so a
steady-state flip re-sends a known serial and the server maps nothing. The two mature systems chose
opposite sides — so decide it on this project's terms, and those terms favour server-allocated.
Recorded as proposed **D17**.

**M7 is missing two things the window fd will have to express**, and both are cheaper before M9 and
M10 are built on top:
1. **The destroy cascade.** Destroying a parent destroys its children, so closing one fd must be
   reported as closing *several*. SerenityOS's `destroy_window` returns the list of ids destroyed.
   M7 has no such event, so the process's fd table silently desynchronises from the kernel's.
2. **Cross-process ownership.** A picker broker must be able to parent its dialog onto the
   *requesting app's* window — that is the whole point of a broker — and M9's owner chain has no
   way to name a window in another process.

Also: M9's `modal ∈ {none, window, app, system}` describes *scope*, where SerenityOS's enforced
`WindowMode` describes *behaviour* — `Modeless | Passive | RenderAbove | Blocking`, with the blocker
computed by walking the chain. Those are different axes and an owned window needs both.

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

## Option D — the teaching machine and learning mode

Rationale, the honesty policy and the coverage matrix are in `docs/LEARNING-MODE.md`. The
milestones live here, with the same contract as everything else: **a proof that can fail, and a
negative control that breaks the thing the proof is about.**

**Order is risk-first.** D0 re-measures the one figure option D rests on, against a real workload
rather than the 5-instruction loop that produced 455 MIPS.

### What a reader found by opening the page, and what it was actually about

Four complaints arrived from someone using the desktop in Firefox. **Three of them were not
defects, and the fourth was five.** The single cause of the three is worth more than the fixes.

**`www/m14.html` ran the PROOFS by default**, with the desktop behind `?live=1`. The proofs stage
their own fixture windows and then block in `gestureAsker` waiting for a driver to perform a
gesture — so a person who opens the obvious URL gets windows nobody asked for, caption buttons that
belong to a sequence halfway through, and `Error: nothing performed the … gesture` sixty seconds
later. Every symptom reads as a broken desktop:

- *"I'm unable to open anything."* On the live desktop a double-click on Terminal opens a terminal.
  Measured, in Chrome: two windows before, three after.
- *"The minimize button doesn't work."* On the live desktop it does: state 0 → 1, the frame hidden,
  and the taskbar button puts it back. Measured both ways.
- *"The white half of the screen."* That is `#seam`, the hard black/white backdrop the glass is
  sampled across, which constraint 50 requires and which `live()` hides. It is a proof fixture doing
  its job on a page a reader should not have been on.

So the default is the desktop now and `?proofs=1` is the harness's to ask for — and because the
same trap exists on six other pages, `gestureAsker` paints a banner after 2,500 ms naming the
gesture it is waiting for and the URL that gives the product. It is removed the moment anything
drives it, so a driven run never shows it. **Constraint 283.**

### And five real defects behind the fourth complaint

**THE HOVER THUMBNAILS RENDERED OUTSIDE THE GLASS.** `.shell-popup`'s `max-width: 320px` is right
for a menu row and wrong for a 208 px thumbnail, so a group of two laid out 422 px of content
inside a 218 px panel and `overflow: visible` painted the second one on the bare desktop. Measured
at 1320x900: cell 2 at x=434 in a panel spanning 220..438; 432 px wide with both inside after. The
cap is derived from `THUMB_W` and `THUMBS_PER_ROW` now and the strip wraps. **And the thumbnail
itself read as a blank white rectangle** — nine lines of 9 px text on a near-white fill — so a text
window's preview is drawn as a miniature window: a caption strip in the same blue, its title, and
the text below as the texture it becomes at that scale. A preview at 196x120 cannot be legible and
Windows 7's is not either; what it has to be is recognisable. **Constraint 285.**

**THE OUTLINES HAD NO CONTRAST ON A LIGHT BACKDROP.** A near-white 2 px border is crisp over a dark
desktop and invisible over a pale one, which is the snap ghost and the rubber band over any light
wallpaper. Both carry a dark ring outside the light one now: whichever tone the backdrop swallows,
the other shows. Constraint 50's argument about glass, applied to an edge. **Constraint 286.**

**THE LIVE DESKTOP STOPPED 190 px SHORT OF THE WINDOW.** `#desktop { height: 560px }` is the
PROOFS' geometry and it is load-bearing for them — the pixel proof reads device rects out of a
screenshot and a growing log would move the desktop out from under them — but applied to the live
page it left page background below a Windows 7 taskbar. Live mode is a flex column now: the log
capped at 22vh, the desktop taking the rest. Measured: 0 px of slack where there were 190.

**AND THE ICONS DID NOT SNAP TO A GRID**, which is what was asked for. `#cellAt` is the declared
inverse of `#boxFor` — the relationship `src/wm/surface.mjs` states between `clientAt` and
`pointAt` — so a drop lands exactly where the auto-layout would have put it. The arrangement holds
a CELL and not a pixel, so a resized desktop re-lays it out rather than stranding an icon. Snapping
MAKES STACKING REACHABLE, because before it a dropped icon sat between cells and never exactly on
one — so the dragged cells are reserved before anything is laid out and a drop takes the nearest
FREE cell. Measured: a drag of (173, 61) from (54, 507) landed on cell (2, 4) = (180, 360), and
held across a redraw. **Constraint 284.**

### What the harness said about all this, including about itself

**`bench/m7-win/drive.py --live` OPENED NO WINDOW.** The command `CLAUDE.md` advertises as "the
Windows 7 desktop, in a real Chrome, left open to type into" took `cdp.Browser()` at its default,
which is headless — then span for 300 s waiting for a terminal state a live page never reaches. It
also spawned `scripts/serve.py --port 8711` with both streams sent to DEVNULL, so a busy port
arrived as a blank page with no message, and 8711 appeared in no document while `scripts/serve.py`
alone serves 8000. A reader reported that as the contradiction it is. Every driver binds
`serve.Server` in process on port 0 now and prints the URL; `bench/m10-data/shell.py` and
`bench/shell-reports/repro.py` had both claimed 8717. **Constraint 287.**

**A `const` COST 420 SECONDS.** Renaming the drop target collided with a binding fifty lines above
it, and `scripts/check.py --only m14` reported it as BROKEN with `never became true within 420.0s`
— correct and honest, and a four-hundred-fold waste, because the page threw before it rendered and
a harness can only wait for a state that will never arrive. `scripts/check_pages.py` runs
`node --check` over every page's inline module in about a second, and `--prove-failure` injects a
redeclaration into all eighteen and requires every one to report it. **Constraint 288.**

**THE REGISTRY REFUSED THE FIRST DECLARATION OF THE NEW CONTROL**, which is the gate earning its
keep. `--negative no-icon-grid` answered: *"m14 recorded 'and on the NEAREST cell to where it was
let go' and it HELD under this control, so whatever turned the check red is not the thing this
control is named for."* It holds for a reason worth keeping — a loose drop lands at EXACTLY the
pointer's pixel, so a half-cell bound is satisfied by zero. That clause cannot stand alone; what it
is for is telling a view that snaps to the nearest cell apart from one that snaps everything to a
fixed cell. Re-declared, the control scores **3 red and 54 intact**.

**AND THE CLAUSE IT REPLACED WAS NOT ABOUT THE GRID AT ALL.** "A drag moves an icon" asserted the
icon arrived at exactly `+160,+90`, which is a statement about the POINTER and true of a view with
no grid whatever. The delta is 173x61 against an 86x88 cell now, and the drop having been off-grid
in the first place is asserted separately — because if `want` happened to be a cell corner, "it
snapped" and "it did not move" are the same picture.

### "Still, I'm unable to open anything" — the second report, and what it really was

The first report had three symptoms that were not defects and one that was five. **This is the
sentence that came back after all of them were fixed**, and it was right: the desktop still did not
work, for reasons none of the first round touched. What found it was not another Chrome run.

**THE CHROME SUITE WAS GREEN THROUGHOUT.** 57 expectations over nine proofs, every gesture a real
pointer. Not one of them asks whether the things on the desktop LAUNCH — they drive snap
thresholds, grouping, modality and the blur governor on a page that stages its own fixtures. The
question a reader asks first was not in the registry at all.

**SO FIREFOX WAS DRIVEN, WHICH THIS REPOSITORY SAID WAS IMPOSSIBLE.** `bench/m7-win/firefox.py`
opens with "Mozilla removed CDP, so there is no driver", and `CLAUDE.md` makes a second engine a
condition of reporting a milestone done while offering only a screenshot to do it with. That is
true of CDP and false of the browser: **Firefox 156 speaks WebDriver BiDi**, and
`input.performActions` delivers events carrying `isTrusted === true`. `scripts/bidi.py` is the
driver and its self-test is the evidence. The endpoint is `--remote-debugging-port`, the path is
`/session` rather than `/`, and the handshake must carry no `Origin` header — three facts that each
cost a confusing failure. **Constraint 292.**

Three defects fell out within minutes of having it:

**A WINDOW OPENED ON THE ICON COLUMN AND THE DESKTOP STOPPED WORKING.** `term` created its window
with no x or y, which is 0,0; `files`, `editor` and `paint` each asked for x:40. The icons fill the
first column down the left edge, so they occupy x 8..94 — and `elementFromPoint` on each icon's own
click point reported **4 of 4 icons answering `window:Terminal`**. Open one thing and every
subsequent double-click hits the window instead. That is the whole of "I'm unable to open
anything", and a bounding-box overlap test would have been a guess where the hit test is the
answer. `WIN_ORIGIN_X` is now the one definition of a corner clear of the column, in
`src/libos/std.mjs` beside `iconForPath` — userland's, because the kernel knows nothing about
icons. **Constraint 289.**

**TWENTY OF TWENTY-SIX START-MENU ROWS DID NOTHING, CORRECTLY.** Most of `/usr/bin` writes to
stdout and owns no window, and the menu lists every program in the directory on purpose. Spawned
bare, `cat` and `ls` and `grep` started a process that wrote to a stdout nobody was showing and
exited. The default is inverted now: a program not in `OPENS_OWN_WINDOW` runs inside a terminal,
which is what Windows 7 does with a console program. `term --run` writes the command to the PTY
MASTER after the first output — the input side, so the line discipline echoes it and the reader is
left at a live prompt rather than looking at a dead window. Measured: `ls` shows
`~$ ls / bench/ desktop/ dev/ proc/ tmp/ usr/ / ~$`. **Constraint 290.**

**AND A SECOND WINDOW LANDED EXACTLY ON THE FIRST.** Programs name constants, so two `files`
windows shared a pixel and the second was indistinguishable from a launch that never happened —
which is how it was first read here, as "a double-click on a folder does nothing". `WinMgr.#cascade`
steps an exact corner collision down-right; a mere overlap is left alone, because overlapping is
what windows do. Measured after the fix: 160,48 / 184,72 / 208,96 / 232,120. **Constraint 291.**

### What the new gate does, and the proof it can fail

`bench/m14-shell/firefox-drive.py` asks the reader's own question and nothing else: every icon
opens a window, the icons are still reachable after a launch, a console row opens a terminal that
RAN the command, and no two windows share a corner. Eight host checks went into
`bench/m14-shell/probe.mjs` for the cascade rule itself — including that a MAXIMIZED window's stale
corner pushes nothing and that the desktop never does — and the probe is 80 now.

`--prove-failure` parks a window on the icon column through the frame's own geometry route. In that
world the gate reports **every double-click opening nothing, four times over**, which is the
reader's report reproduced on demand. Two of the eight host checks failed when first written, both
because `setState` and `setRole` take a Window and not an id — so the harness caught its own
author before it scored anything.

### What this cost, stated plainly

Three rounds of "it works in Chrome" against a reader who could not open a folder. The lesson is
not that Firefox differs — **it did not**: every one of these three defects is present in Chrome
too, and the Chrome suite would have found none of them, because no registered check launches
anything from the desktop. A second engine was the accident that made someone look.

### One thing found and NOT changed, with the reason

**RESTORING A WINDOW THAT WAS SNAPPED BY A DRAG PUTS IT WHERE THE DRAG ENDED, NOT WHERE IT
STARTED.** Measured: a window at `{x: 594, y: 40}` dragged to the left edge snaps to
`{x: 0, y: 0, w: 660, h: 649}`, and a caption restore returns it to `{x: -9, y: 185}` — the box the
drag left it in, nine pixels off the left edge, because `setState` takes the restore point on the
way out of a floating state and by then the drag's own `pointerup` has already recorded the new
box.

It is arguably right: dragging a window OUT of a snap in Windows 7 puts it under the cursor, and
this is the same box. What Windows 7 does for a caption-button restore of a drag-snapped window is
**not something this note can state** — nobody here has measured it — so it is recorded as an open
question rather than fixed in either direction. It is also the machinery the critic's worst finding
was about (the restore point that outlived the return it paid for), so moving when the point is
taken needs its own proof and its own control, not a nudge. Nothing reported it; it was found while
checking why a harness printed a box that disagreed with its own state.

## M15 — the shell's own programs · done · 1 day

### One bug the M16 audit found in this milestone's own code

**`taskmgr` TESTED THE POINTER FLAG AGAINST THE Y COORDINATE.** `src/bin/taskmgr.mjs` read
`ev.b & WPTR_DOWN`, and `ev.b` is the pointer's y — `pointerAt` is `{x: ev.a, y: ev.b,
buttons: ev.c}` (`src/abi.mjs:1424`). DOWN/UP/MOVE travel in `mods` (`src/abi.mjs:418`, 463), which
`src/bin/files.mjs:443` and `src/bin/paint.mjs:184` both get right; this was the one copy that did
not. The effect was periodic in y: bit 0x10 of the row's own centre, so clicking a row worked in
alternating 16-pixel bands and the rows between them were dead.

**IT SHIPPED BECAUSE THE GATE CLICKED NO ROW.** `bench/m14-shell/taskmgr.py` asserted the table was
drawn, that the rows were `/proc`'s, and that kernel time rose — and never pressed one. It now
clicks five rows and asserts the selection followed, read out of the PIXELS the program drew
(the selected band's fill colour) rather than out of a state channel it does not have. Five
heights and not one, because the failure was periodic: at the old code the y values 49, 85 and 121
pass and 67 and 103 do not, so a one-row check passed or failed by luck.


**WHAT ASKED FOR IT.** Four things, from someone using the desktop rather than reading the plan:
more core Linux in the terminal, a file system view that is "not correct", a task manager, and
"when hovering over an app on the task bar, I am unable to go scroll up to focus on a specific
process". None of the four is in `PLAN.md`; all four are what a working desktop makes askable.

### The hover flyout was taking itself away mid-gesture

There is nothing to scroll. The thumbnail panel sits `TASKBAR_H + 6` px above the bar, and
`pointerleave` on the button closed it AT ONCE — so the pixels between the button and the panel are
over neither element, and the panel closed in that gap every time the pointer crossed it. The close
is scheduled now and entering either half cancels it, which is what Windows 7 does with the same
flyout. **Constraint 295.**

`bench/m14-shell/firefox-hover.py` performs the crossing and then clicks a thumbnail, asserting the
window it names came to the front. `--prove-failure` restores the instant close and reports the
panel GONE after the crossing — the report reproduced on demand. **And the control had to be armed
AFTER the spawn**: `Taskbar.sync` rebuilds the button band when a window appears, so the first
version attached listeners to elements that no longer existed and broke nothing. The gate said so
rather than passing, which is the second time in two days that a control's own declaration was the
thing that was wrong.

### `mkdir: command not found`

Twelve programs: `mkdir -p`, `rmdir`, `rm -rf`, `cp -r`, `mv`, `touch`, `pwd`, `stat`, `df`,
`tail`, `sort`, `uniq`. Every one is a program over the path group `src/abi.mjs` has had since M3 —
`mkdir`, `rmdir`, `unlink`, `rename`, `link`, `stat`, `chmod`, `truncate`, `statfs` — so **nothing
below the ABI changed to add them**. What was missing was the programs and their rows in
`USR_ENTRIES`.

TWO OF THEM CANNOT DO WHAT THEIR NAME PROMISES, and say so in their own files rather than pretending:
`touch` cannot set a timestamp, because this ABI has no `utimes`, and `pwd` reads `/proc/<pid>/cwd`
because there is no `getcwd` — which makes it a check on whether the cwd crossed `spawn` as well as
a convenience.

`bench/m14-shell/coreutils.py` runs **38 cases at a real prompt**, through a pty and a real shell,
and every case carries its own negative half: `mkdir` is checked by `ls` seeing the directory AND by
`mkdir` on the same name failing; `rm -r` by the tree going AND by `rmdir` having refused it first.
Three of the 38 failed on the first run and all three were the TEST's expectations — this system
prints the errno by name (`EEXIST`, `ENOENT`) where the assertions wanted prose, which is both this
project's convention and the more precise claim.

### "The file system view is not correct" — it was coloured stripes

`src/bin/files.mjs` drew a 22 px rectangle per entry, coloured by format, with no name on it. That
was not a styling choice: **the display list had no text op**, so a file manager could draw a row
and not what the row WAS. A GUI whose windows cannot render a string cannot have a list in it, and
a task manager was unwritable for the same reason — which is why one ask unblocked the other.

`DL_TEXT` plus `DL_TEXT_DATA` is the answer and it is additive: a header declares the run and
continuation records carry its bytes, 24 per record, so the batch is still a whole number of
fixed-size ops and the kernel still counts records without interpreting them. **Constraint 293.**
The three candidates and why this one: a string table appended to the batch changes the call's
payload shape, which the kernel counts in records; a kernel-side intern table is new calls, new
state and a lifetime to get wrong.

**CLAUDE.md SAID "A DISPLAY LIST HAS NO TEXT OP" FOR FOUR MILESTONES, and the argument it was
load-bearing in survives.** D39 says the shell is page-side because a process could not draw one; a
shell needs hover, a menu that outlives a button press, and a rubber band, and none of those is a
drawing op. What the text op bought is a process that can draw a LIST.

Then the file manager showed two more defects the moment it was legible, both visible in one
screenshot: every row's type read `fmt?0` — `fmtName(0)`, which is every program in `/usr/bin` —
and 32 rows made a 736 px surface, a window taller than the work area with its last rows under the
taskbar and **no wheel event to scroll with**. The type column reads DIR / a format name / PROG /
a dash now, at one `lstat` per row, and the height is capped with the remainder stated:
"+8 more — run `ls /usr/bin` to see them all". **Constraint 294.**

### A task manager with no CPU column, and why that is the honest version

Windows 7's has one. **This system has no scheduler**: a process is a Worker, the browser decides
when it runs, and nothing here is told how long it ran for. A "% CPU" column would be a number
invented in `src/bin/taskmgr.mjs`, and a plausible invented number is worse than an absent one —
the same argument M11 used for drawing a caption button DISABLED rather than live.

So the columns are what the kernel measures, under names that say what they are. `Slot.serviceMs`
is the time the KERNEL spent servicing a process's syscalls, attributed at the three dispatch sites
from the clock `kServiceMs` already used globally; `readBytes` and `writeBytes` are counted in
`finish`, which is the one funnel every answered call passes through — so a new read-shaped call
cannot forget to account itself, and a negative return is an errno rather than a count. All three
are published in `/proc/<pid>/status`, and the window carries the caveat on its own face: "KRNLms
is kernel time servicing syscalls, not CPU".

IT IS A USERLAND CLIENT OF `/proc` WITH NO PRIVILEGE — the same files `ps` reads. That is the point
of it being a program: a task manager needing a capability would be evidence the boundary leaks.

### Two second copies retired, and one retired by arriving

`src/bin/files.mjs`'s row geometry was restated in `www/m10.html` and `bench/m10-data/shell.py`,
and CLAUDE.md listed both with the consequence spelled out — "a drift there arrives as the WRONG
FILE being dragged, which the run prints". **This milestone moved the rows**, which is that drift
arriving, so both read `FILES_METRICS` now. The bench script's stated excuse was that it is outside
the process and cannot import the module; that was true of the PROCESS and false of the page it
drives.

### What is not done

**THERE IS NO PER-PROCESS MEMORY FIGURE**, and the task manager has no column pretending otherwise.
`performance.measureUserAgentSpecificMemory` is per-AGENT, so it reports one number for every
Worker together — attributed to whichever process asked, which is worse than nothing. The surface
area the kernel accounts (`SURFACE_BUDGET_PX`) is the one memory-shaped figure it genuinely owns.

**NO LIST IN THIS SYSTEM SCROLLS.** `files` and `taskmgr` both cap and state their overflow because
`WPTR_DOWN`/`UP`/`MOVE` is the whole pointer vocabulary — there is no wheel record in `WEV_*`. That
is an ABI gap and the honest fix is a wheel event, not a scrollbar drawn in a program that cannot
receive input for it.

**THE KERNEL'S REFUSAL OF A MALFORMED TEXT RUN IS WIRED BUT NOT DRIVEN.** `textOfOps` returning
null for a lone header and for a truncated run is asserted in `src/abi.mjs`'s selfTest, and
`win_draw` uses that same function to answer -EINVAL — so the DECISION is checked and the three
lines of WIRING are not. Driving it needs a process that sends a deliberately malformed batch, and
no program here has a reason to; the honest shape is a bench program whose whole job is to send
one, which is owed rather than done. The renderer's half IS measured: 66 text runs drawn with 0
unknown ops, read out of the canvas in Firefox.

**THE COREUTILS ARE NOT POSIX-COMPLETE.** `cp` has no `-p`, `sort` has no `-k`, `rm` has no `-i`,
and there is no `find`, `ln`, `cut`, `tr`, `tee`, `basename`, `dirname`, `date` or `env`. The twelve
here are the ones a reader hit in the first minute; the gap is a list and not a design problem.

### D0 — RV32I interpreter + one real binary · 4 d

**Build.** RV32I base integer set, decode-and-execute from memory. One prebuilt binary committed
to the repo (no toolchain dependency for a reader).

**Proof.** The binary runs and produces its known output. Then **re-measure MIPS on that real
workload** and record it beside the 455 MIPS synthetic figure — the benchmark that produced 455 was
a 5-instruction loop with a hot dispatch path and good branch prediction, so a real program will be
slower.

**Negative control.** Corrupt one instruction's decode (swap `ADDI`'s immediate sign extension).
The binary must produce wrong output or trap — if it still passes, the proof is not reading the
interpreter.

**Kill criterion.** Real-workload throughput below 20 MIPS → the tier is too slow to be a tier.
Reconsider before D1.

### D1 — Sv32 MMU · 3 d

**Build.** Two-level page tables, 4 KiB pages, a TLB, page faults vectoring through the trap
mechanism.

**Proof.** Two processes write the *same virtual address* and read back different values — which is
the entire point of translation and is inexpressible in tier 1. An unmapped access faults with the
correct `mcause`, and the handler runs.

**Negative control.** Make translation the identity map. The two processes must start seeing each
other's data, and the first assertion must fail.

### D2 — Traps, timer, real preemption · 2 d

**Build.** `mtime`/`mtimecmp`, `mtvec`/`mcause`/`mepc`, a quantum expressed in instructions.

**Proof.** A process that issues **no syscalls at all** is still switched away from. Count context
switches over one second of two spinning processes and assert it is within tolerance of
`elapsed / quantum`. This is the thing tier 1 cannot do.

**Negative control.** Disable the timer. The switch count must collapse to the syscall-driven count
(zero, for two spinning processes), and the check must fail.

### D3 — Scheduler policies · 3 d

**Build.** Round-robin, MLFQ, lottery and stride as swappable modules behind one interface.

**Proof.** The *same* workload — one interactive and two batch processes — run under each policy
produces different and *predicted* turnaround and response times. Assert the ordering: MLFQ gives
the interactive process a lower mean response time than round-robin, and round-robin lower than
FCFS. The convoy effect is reproducible on demand.

**Negative control.** Make every policy return the same choice. The orderings must collapse and the
assertion must fail — otherwise the test is measuring noise rather than policy.

### D4 — `fork`, copy-on-write, demand paging · 3 d

**Build.** Fork by copying the interpreter's state object; mark pages read-only and copy on write
fault; page out to OPFS on pressure and fault back in.

**Proof.** Child returns 0, parent returns the pid, and the child's writes are invisible to the
parent. A COW page's **physical frame number is identical in both processes until one writes** —
assert the frame id, not the contents. Demand paging: touch a paged-out page and assert the fault
count incremented and the data is correct.

**Negative control.** Eager-copy instead of COW. The shared-frame assertion must fail. Separately,
pin all pages — the demand-paging fault count must drop to zero and that check must fail.

### D5 — Device bus, providers, hot-unplug · 9 d

**Build.** Device bus on the emulated machine; synthetic block device with a latency model that
*replays a measured distribution*; provider table (`raw.githubusercontent.com`, `cdn.jsdelivr.net`
free; one owned R2 bucket); buffer cache with swappable eviction; PIO and DMA as two
implementations; RAID 0/1/5 across providers.

**Proof.** Four, and the first is the one that keeps the rest honest:
1. **A CI capability probe per provider** — ranged GET returns exactly the requested byte count with
   `Content-Range`, and CORS is present. A provider that silently stops supporting `Range` must fail
   the build, not degrade a page.
2. A block read at a known LBA returns known bytes through the cache.
3. Hot-unplug: kill connectivity mid-read and assert `EIO` propagates up through the cache to the
   process, with a partially filled buffer discarded rather than returned.
4. Eviction policy matters: the same access pattern under LRU and under clock produces different
   measured hit rates, in the predicted direction.

**Negative control.** Point a provider at a 404 URL — the synthetic fallback must engage *and the
page must say it did*. A silent fallback is the failure mode this whole milestone is guarding
against. Then set the latency model to 0 µs and confirm the eviction-policy assertion collapses,
proving it was measuring cache behaviour and not scheduling noise.

### D6 — Two tabs, minimal NFS · 3 d

**Build.** `BroadcastChannel` as the link — no server, no signalling. Synthetic latency and loss
model. A minimal NFS with whole-file caching.

**Proof.** Tab A writes, tab B reads the new content. Then set loss to 20% and assert the
retransmission path recovers. Then **cause a stale-cache read on demand** and assert the client
detects it.

**Negative control.** Disable cache invalidation — the stale read must go undetected and the check
must fail.

### D7 — Page harness, scrubber, check runner · 6 d

**Build.** The page template, the trace scrubber over `/dev/trace`, and the runner that executes
every page's check.

**Proof.** The scrubber reconstructs a known syscall sequence from a recorded trace, and the
reconstruction matches the sequence that was recorded. The dropped-record counter is visible and
non-zero when the ring is deliberately undersized.

**Negative control.** Undersize the ring to 64 KiB and run at full syscall rate. The dropped-record
counter must become non-zero **and be displayed** — a trace view that silently drops records shows
a clean picture of a broken system.

### D8 — The 35 principle pages · 14 d

**Proof.** Every page carries a check, and `--prove-failure` inverts all of them so the run must
report failures.

**Negative control.** That *is* the control — the mode exists so the lesson suite can be seen to
fail. A page whose check cannot fail is not a page.

---

## Open experiments

Cheap measurements that should happen before the milestone that depends on them. `PLAN.md` §10 has
the full list of unresolved items. **The first row is retired** — struck through, with its result,
because an experiments table that drops its answers teaches the reader to re-run them.

| Experiment | Before | Cost | Why |
|---|---|---|---|
| ~~Can `Atomics.notify` interrupt a worker inside a synchronous OPFS read?~~ | ~~M4~~ | 0.25 d actual | **DONE — no, it cannot, and the ABI is honest anyway.** A thread in a synchronous call is not in `Atomics.wait`, so the notify woke 0. But the handles are in the I/O worker since M0b, so the CALLING process parks and is interruptible; a signal waits one chunk, **10 µs p99**. `bench/m4-intr/probe.py`, constraints 86–89. |
| Why is spawn 1.3–1.6× constraint 19's figure on this build? | M1 | 0.25 d | M0 excluded `Blob`/`createObjectURL` and classic-vs-module; what is left is the patch build, script size, and sample count. Re-run gap-04's own spawn harness here. M1 spawns constantly, so an unexplained 1.5× is worth a quarter day. |
| Does the worker ceiling knee between 256 and 3,200? | M1 | 0.5 d | M0 stopped at 256 with zero failures but per-worker cost was still rising. Constraint 17 sets the design limit at 1,000, which sits inside the unmeasured gap. |
| Is a journal append plus `flush()` durable across a kill? | before storing anything real | 1 d | The spec says "attempt to transfer" and allows a no-op. Build the zip-export affordance regardless. |
| Calibrate the blur ceiling at boot instead of hard-coding one machine's number | M12 | 0.5 d | Turns an unknown into a runtime measurement, which is strictly better than more research. |
