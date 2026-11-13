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
| M1 | Process lifecycle, signals, hard cap | 4 | | ⬜ |
| M2a | A host-runnable kernel, fuzzable codecs | 1 | | ⬜ |
| M2 | VFS core on OPFS | 8 | | ⬜ |
| M3 | `/proc`, `/dev`, mounts, provider iface, /dev/trace | 4 | | ⬜ |
| M4 | Pipes, pty, line discipline | 5 | | ⬜ |
| M4a | The terminal gets a real window | 2 | | ⬜ |
| M5 | The shell and ten programs | 6 | | ⬜ |
| M6 | Neuter the process realm | 2 | | ⬜ |
| | **— end of spine. Choose option A / B / C here —** | **33.5** | | |
| M7 | A window is a file description | 4 | | ⬜ A |
| M8 | The window surface | 3 | | ⬜ A |
| M9 | Owner, modality, close-request | 3 | | ⬜ A |
| M10 | Typed clipboard and drag-and-drop | 4 | | ⬜ A |
| M11 | Aero glass, frame-only, plus reskin | 5 | | ⬜ A |
| M12 | The blur governor | 3 | | ⬜ A |
| M13 | The geometry harness | 5 | | ⬜ A |
| M14 | Snap, Superbar, jump lists, tray | 6 | | ⬜ A |
| — | Icons and fonts, redrawn | 4 | | ⬜ A |
| | **Option A total** | **73** | | |
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
| `/dev/trace` ring + dropped-record counter | M3 | 1 d | Measured at **4 ns/record** — 0.03% of a syscall. Tracing is free, and it is the debugger for everything after it. |
| `top` and `strace` as real programs | M5 | 2 d | A live syscall histogram on day 3 is a better M0 deliverable than a number in a terminal. |

The trace ring needs **≥16 MiB** and a visible dropped-record counter: a 1 MiB ring holds 32,768
records and wraps every 0.5 s at full syscall rate, and a view that silently drops records shows a
clean picture of a broken system.

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

## M2a — A host-runnable kernel, before M2 · 1 day

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

## M2 — VFS core on OPFS · 8 days · ~1400 LoC

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

## M3 — `/proc`, `/dev`, mounts · 4 days · ~700 LoC

Was 2 days. Carries two things folded in from option D because they are OS work rather than
pedagogy, and because building them later means building them twice.

**Build.** Longest-prefix mount table, static at boot: `/` OPFS rw, `/usr` read-only, `/tmp`
tmpfs, `/proc` and `/dev` generated on read. `/proc/<pid>/{status,cmdline,cwd,fd/<n>}` is ~120
lines and is the clearest demonstration that a process is a first-class object.

**Folded in (a): `/usr` mounts on the provider interface, not a one-off driver.** +1 d. The
original plan had a bespoke `httpimg` driver here and a general provider table later in option D.
That is the same work twice. So `/usr` is the *first consumer* of a provider table that is data,
not code:

```
{ id, url template, range strategy, max object, auth: 'none' }
```

Measured 2026-11-12: `cdn.jsdelivr.net` and `raw.githubusercontent.com` both serve genuine ranged
block reads with `Content-Range` and CORS, so the default needs no account and no bucket.
`unpkg.com` ignores `Range` and is unusable. `docs/LEARNING-MODE.md` §5.

**Folded in (b): `/dev/trace`.** +1 d. A ring buffer the kernel writes two records into per
syscall, measured at **4 ns a record** — 0.03% of a 14 µs syscall, so tracing is always on. This
is the debugger for every milestone after it, which is why it is here and not at the end.

**Proof.** Three:
1. `ls /proc` enumerates live pids; kill one and its directory vanishes.
2. **A capability probe per provider** — a ranged GET returns exactly the requested byte count
   with `Content-Range`, and CORS is present. A provider that silently stops supporting `Range`
   must fail the build, not degrade a mount.
3. `/dev/trace` replays a known syscall sequence, and the dropped-record counter is visible.

**Negative control.** Three, one per proof:
1. Serve a cached `/proc` listing instead of regenerating — the killed pid must linger and the
   check must fail.
2. Point a provider at a 404 — the mount must fail loudly, never silently serve an empty `/usr`.
3. Undersize the trace ring to 64 KiB at full syscall rate — the dropped-record counter must go
   non-zero **and be displayed**. A trace that silently drops records shows a clean picture of a
   broken system.

**Note the sizing.** A 1 MiB ring holds 32,768 records and wraps every 0.5 s at full syscall
rate. Ship ≥16 MiB if the scrubber (D7) is ever wanted.

**`mount` must never accept a caller-supplied URL** — a provider id and a path, resolved against
the committed table, and nothing else. Otherwise every process gets an SSRF primitive, and M6
deletes `fetch` precisely to prevent that.

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

Three cheap measurements that should happen before the milestone that depends on them. `PLAN.md`
§10 has the full list of unresolved items.

| Experiment | Before | Cost | Why |
|---|---|---|---|
| Can `Atomics.notify` interrupt a worker inside a synchronous OPFS read? | M4 | 0.5 d | If not, `read()` is not interruptible and the ABI is lying about Ctrl-C. Weakest point in the cancellation design. |
| Why is spawn 1.3–1.6× constraint 19's figure on this build? | M1 | 0.25 d | M0 excluded `Blob`/`createObjectURL` and classic-vs-module; what is left is the patch build, script size, and sample count. Re-run gap-04's own spawn harness here. M1 spawns constantly, so an unexplained 1.5× is worth a quarter day. |
| Does the worker ceiling knee between 256 and 3,200? | M1 | 0.5 d | M0 stopped at 256 with zero failures but per-worker cost was still rising. Constraint 17 sets the design limit at 1,000, which sits inside the unmeasured gap. |
| Is a journal append plus `flush()` durable across a kill? | before storing anything real | 1 d | The spec says "attempt to transfer" and allows a no-op. Build the zip-export affordance regardless. |
| Calibrate the blur ceiling at boot instead of hard-coding one machine's number | M12 | 0.5 d | Turns an unknown into a runtime measurement, which is strictly better than more research. |
