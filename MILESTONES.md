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
| M0a | Addendum: the same sweep with a real OPFS call in the mix | 0.5 | 0.5 | ✅ done — **the I/O worker is required**, not optional |
| M0b | Move the OPFS handles to a second kernel-side worker | 1.5 | 0.5 | ✅ done — cheap p99 185 µs at N=16, K=1 |
| M1 | Process lifecycle, signals, hard cap | 4 | 1 | ✅ done — a spinner dies on End Process |
| M2a | A host-runnable kernel, fuzzable codecs | 1 | 0.5 | ✅ done — 10k torn journals, 0 accepted |
| M2 | VFS core on OPFS | 8 | 3 | ✅ done — 10k files intact, 8 verification rounds |
| M3 | `/proc`, `/dev`, mounts, provider iface, /dev/trace | 4 | 1 | ✅ done — **ACCEPT**, 55 expectations, 3 controls, 9 review findings fixed |
| M4 | Pipes, process groups | 5 | 1 | ✅ done — **ACCEPT**, 23 expectations, 1 control, 12 review findings fixed |
| M4b | pty, line discipline, `poll` | 2 | 1 | ✅ done — **ACCEPT**, 54 expectations, 4 controls |
| M5 | The shell, eleven programs, exec through the filesystem | 6 | 1.5 | ✅ done — **ACCEPT**, 38 expectations, 6 controls, 14 review findings fixed |
| M4a | The terminal gets a real window | 2 | 1 | ✅ done — **ACCEPT**, 26 expectations, 1 control |
| M6 | Neuter the process realm | 2 | 0.5 | ✅ done — **ACCEPT**, 31 expectations, 2 controls, and constraint 139's prescription corrected |
| | **— end of spine. Choose option A / B / C here —** | **35** | | |
| **M7** | **A window is a file description** | 4 | | ⬜ **next (option A)** |
| M8 | The window surface | 3 | | ⬜ A |
| M9 | Owner, modality, close-request | 3 | | ⬜ A |
| M10 | Typed clipboard and drag-and-drop | 4 | | ⬜ A |
| M11 | Aero glass, frame-only, plus reskin | 5 | | ⬜ A |
| M12 | The blur governor | 3 | | ⬜ A |
| M13 | The geometry harness | 5 | | ⬜ A |
| M14 | Snap, Superbar, jump lists, tray | 6 | | ⬜ A |
| — | Icons and fonts, redrawn | 4 | | ⬜ A |
| | **Option A total** | **74.5** | | |
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

**Built.** `src/kernel/console.mjs` is `/dev/console`: one host-backed device, a keystroke queue
one way and a post to the page the other, with a row in `src/kernel/files.mjs`'s ops table
(`F_WIN`, the kind the ABI reserved by name) and a row in `pollOne`. `src/bin/term.mjs` is the
terminal emulator AS A PROCESS — it opens the console, opens a pty, spawns `/usr/bin/sh` on the
slave in its own foreground group, and polls BOTH sources. `src/wm/window.mjs` is
`../webxp/src/window.mjs` ported unstyled: the two-box geometry, the clamp, the pointer drag and
the keyboard equivalent of it. `src/wm/terminal.mjs` is the widget, and **it draws nothing on a
keypress**. `www/m4a.html` wires the four together.

**The special case, and its expiry.** One console, created by the kernel when the page attaches a
window, with `open("/dev/console")` as its only producer. Said in `src/kernel/console.mjs`'s
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
`node bench/m4a-console/probe.mjs` (65 host checks over the device, no browser),
`node bench/m4a-window/probe.mjs` (29 host checks over the clamp; two mutations move 10 and 2
labels and leave the rest) and
`node bench/m3-synth/probe.mjs` (98 host checks, 13 of them `/dev/console`'s in the mount table).

**Two defects the build found in ITSELF, by reading rather than by a failing proof, and both are
checks now.** `detach` cleared the keystroke queue and left the stale clock running, so a
DESTROYED window reported "(Not Responding)" — a caption on a frame that is gone. And `waitpid`
came after the loop unconditionally, so the CEILING path — the one that exists to report a session
that stopped — would have hung in the act of reporting it. The first is two labels in
`bench/m4a-console/probe.mjs`, shown capable of failing by removing the one line that fixes it; the
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
  `default-src 'none'; script-src 'self' blob:; connect-src 'none'; worker-src 'none'`. That is
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

**Label honestly, and the docs do:** hardening, not a security boundary. Same-origin is not a
security boundary and the threat model is first-party only for v1. What remains open is written
down rather than implied — `script-src 'self'` still permits any same-origin module (199) — and
M6 ships no document policy on purpose (200).

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
