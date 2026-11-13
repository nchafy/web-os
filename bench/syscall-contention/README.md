# m0-syscall — the kernel syscall channel under closed-loop contention

What M0 owes: a per-call p99 for a blocking SAB syscall channel with N processes all outstanding,
with the contention shown to have happened rather than asserted. The gate is in `bars.json`:
accept below 500 µs p99 at N=16, kill above 2 ms.

```sh
bench/syscall-contention/probe.py --smoke                      # kernel boots, 1 process, getpid
bench/syscall-contention/probe.py --n 1,4,16,64,128 --window-ms 3000 --runs 3 --hb --overflow --force-not-equal
bench/syscall-contention/probe.py --no-isolation               # must abort and print no figures
bench/syscall-contention/probe.py --serve-only                 # the page in your own browser
```

Every figure this harness prints was taken on **Chrome 157.0.8103.52**. `docs/CONSTRAINTS.md`'s
figures were taken on **157.0.8103.38** — a different patch build, so the two are not
interchangeable, and the probe prints that sentence beside its own machine line.

The machine line also carries `navigator.hardwareConcurrency` (**12** logical cores here), the
platform and, per cell, the **agents/cores** ratio: N process workers plus the kernel worker plus
the main thread. At N=16 that is 18 agents on 12 cores — **1.50×** — so part of the wake latency in
every figure is a scheduling queue, and it is the dominant environmental input to the headline.
Quiescence (below) is asserted inside this browser only, so competing load elsewhere on the host
would move every number with nothing in the output revealing it. Both sentences are printed in the
header rather than left to a reader to reconstruct.

The full sweep is 15 cells — 5 values of N × 3 runs, one fresh browser each. Measured basis:
`--n 1,4,16 --runs 2 --window-ms 1000` is **13.6 s** for 6 cells (2.3 s per cell, of which ~1 s is
the browser launch). With 3 s windows the N≤16 cells cost ~4.3 s each; the N=64 and N=128 cells have
not been timed, and spawn scales with N (ready: 73 ms at N=1, 94 ms at N=4, 236 ms at N=16), so
**expect roughly 1.5–3 minutes, extrapolated, not measured.**

## How to run the page, and why the documented command cannot

`CLAUDE.md` says `scripts/serve.py` serves `./www`. **It cannot serve this page.** `www/m0.html`
imports `/src/abi.mjs` and `/bench/syscall-contention/summarise.mjs`, and
`src/kernel/kernel.mjs` resolves `/src/libos/process.mjs`; under a `./www` root all ten URLs in the
module graph 404. Copying `src/` into `www/` to make that root work would be the hand-synced-copy
defect, so it is refused and the bench serves the **repository root** instead.

`probe.py` binds `scripts/serve.py`'s own `Handler` on the repository root, so the COOP/COEP
headers are the same code path either way. To open the page by hand:

```sh
bench/syscall-contention/probe.py --serve-only       # prints the URL, Ctrl-C to stop
```

A failed import no longer shows up as a blank page. `m0.html` carries a **module-graph preflight**
in a classic script — a preflight inside the module it protects cannot run when that module 404s —
which fetches all ten URLs and names the ones that failed, plus a capture-phase `error` listener
for an import the list has not been told about. `--wrong-root` serves `./www` on purpose and is the
proof that path is taken:

```
run 1, N=1: ERROR — module-graph preflight failed, 10 of 10 unreachable: /src/abi.mjs -> HTTP 404; …
```

## One browser per cell, and the quiescence assertion

`terminate()` on the kernel worker does not reap its nested process workers: constraint 14 measured
a terminated worker still advancing a counter at 2004–2051 ms, and a cell boots and warms up in
~70 ms. So **every cell runs in its own fresh headless Chrome**, and the page refuses more than one
`n` per load rather than trusting the harness. The cost is one browser launch per cell — about a
second each, 15 per run of the full sweep.

Before each cell, and before any figure exists, the probe asserts the renderer holds **no dedicated
worker**, via CDP `Target.getTargets`. Measured: five worker targets were still listed 6.1 s after
a four-process cell finished, so this is not a hypothetical. A cell that cannot establish
quiescence reports `INVALID` and no number. `--reuse-browser` is the control that makes it fail:

```
N=1     ok: 0 dedicated-worker target(s), limit 0 · census {'page': 1, 'browser_ui': 1}
N=4     FAILED -> cell INVALID: 2 dedicated-worker target(s), limit 0 · census {'service_worker': 3, 'worker': 2, …}
N=4  INVALID — quiescence failed at cell start: 2 dedicated-worker target(s) from a previous cell are still live
```

## The barrier

Without one, each process ran its own warm-up and then its own window, so the windows did not
overlap and the first dispatch of each genuinely saw an arrival backlog of one. A sweep whose
processes are not simultaneously inside their measured windows is measuring a partially loaded
kernel and calling the result contention.

Every process warms up, resets its histogram, arrives at the barrier and **parks** — an idle park,
so waiting costs the kernel nothing. The kernel polls the arrival count on its own event loop,
publishes **one deadline** for the cell in `G_DEADLINE_LO/HI`, and releases everyone with a single
`Atomics.notify`. The deadline is a `Date.now()` instant because that is the only clock comparable
across agents: `performance.now()` timeOrigins differ per worker, so each process derives its own
monotonic equivalent from the published deadline exactly once.

`G_WINDOW` carries the whole protocol in one word, and both edges matter:

| edge | who | why |
| --- | --- | --- |
| `W_PRE → W_OPEN` | kernel, on the Nth arrival | the windows start together |
| `W_OPEN → W_CLOSED` | the **first** process to reach the deadline | the ramp-down — processes stopping one at a time — cannot put depth-1 samples in a saturated window. Tested at dispatch entry, so the first dispatch after the first departure is already excluded |
| `W_CLOSED → W_DONE` | kernel, once all have left | only then may a process run the out-of-window checks. A 1 MiB write or a 5 ms spin landing inside another process's last millisecond is enough samples to move its p99 |

Reported per cell, and asserted as gate A7: the **intersection** of every process's window in the
wall clock. Measured 99.9–100.2% of the window at N=1…32, with a release spread of 0–1 ms.

### The release ramp

A barrier cannot remove the ramp, only shorten it: N processes released together are woken one at a
time, so whichever issues first sees a backlog of one. Those dispatches are counted in their own
histogram and reported, and the gates read `depthWindow`, which starts at the first dispatch where N
calls were outstanding at once. Gate **A8** is that this moment arrived at all.

## The anti-vacuity gates

`summarise.mjs`'s `gates()` is the only place they live, and it is imported by the page and read by
`probe.py`. Every clause is printed with its value, pass or fail, and a failing clause at the bar's
N makes the verdict **NO VERDICT** — never ACCEPT, never KILL — with the clause named.

| gate | clause | N |
| --- | --- | --- |
| A0 | `depth_p50 == 1` and `depth_max == 1` — the device's own negative control | N=1 only |
| A2a | `depth_max >= 0.75N` — saturation was reached | N>1 |
| A2b | `depth_p50 >= max(2, 0.5N)` — the median dispatch saw half of N queued | N>1 |
| A2c | `queued_fraction >= 0.95` | N≥16 |
| A3 | `little` within 0.15 of 1 (0.85–1.05 at N=1) — and an accounting check: with one outstanding call per process it cannot exceed 1 | all |
| A4 | `depth_p50` and `little × N` agree within 25% | N>1 |
| A5 | `duty_min >= 0.95` and the quietest process made ≥0.2× the mean calls | N>1 |
| A6 | `rho >= 0.90` | N≥128 |
| A7 | the windows' intersection ≥0.98 of the window | N>1 |
| A8 | the window reached N outstanding calls | N>1 |
| A9 | the constraint-7 counters agree to ≥0.95 | all, when observed |

A clause whose precondition does not hold prints **`n/a`**, not `ok`: A2c below N=16, A9 when
neither side observed a not-equal event. It reports and it cannot block a verdict.

**A2c is read at N≥16 only, and that is a scope, not a relaxation.** Below N=16 the per-process
wake-latency gap is too large a share of the cycle for a queued-fraction bar to mean saturation —
measured 0.888–0.892 at N=4 on two clean runs against 0.999–1.000 at N=16. A bar a healthy N=4
cannot meet is not evidence about N=4.

**A9 has no end-to-end negative control, and that is recorded rather than papered over.** No run has
been constructed in which the kernel's notify-woke-nobody count and the processes' not-equal count
genuinely diverge — they are two counters on one event and they agreed to 98.8–100.0% in every run
taken. What shows the clause capable of failing is `agreementSelfTest()` over the pure function
(29/29 → 1, 0/29 → 0, 15/30 → 0.5, 0/0 → `null`) and a direct call to `gates()` with a 0.5
agreement, which fails it. **The gate is unfalsified at the system level.**

### `depth_min` is a witness, not a gate

It was a gate — `depth_max >= 0.75N and depth_min >= 2` — and it failed on **every** clean run while
also reading 1 on the rate-limited control, so it was the one statistic that did not discriminate.
Measured at N=16, window-scoped, ramp and ramp-down excluded:

| statistic | clean N=16 | rate-limited N=16 (`--think-us 2000`) |
| --- | --- | --- |
| `depth_p50` | 13 of 16 | 0 of 16 (the window histogram is empty: A8 never fired) |
| `queued_fraction` | 0.999 | 0.000 |
| `depth_max` | 16 | 0 |
| dispatches at depth ≤ 1 | 127 of 170,016 (0.075%) | 0 of 0 |
| `depth_min` | **1** | **0** — and **1** when the same control was measured with window samples in it |

The last row is the whole point. On the run above the control's window histogram is empty, so its
`depth_min` reads 0 for want of samples; the author's ruling records the same control measured at
`depth_min` **1**, against the clean run's **1**. One statistic, the same value, on a saturated
kernel and on a kernel doing nothing.

`reply()` decrements `G_INFLIGHT` before the woken process re-issues (`src/kernel/kernel.mjs`), so
every process has an un-outstanding interval equal to its own wake latency. That interval is a
property of the design, not a lack of load; over 145,000–518,000 dispatches those intervals coincide
across all N at least once. A minimum over half a million samples is an extreme-value statistic
being asked to certify a distribution, and a gate that fires on every healthy run is a gate on its
way to being ignored.

So `depth_min` and the depth ≤ 1 **count** are printed under a `WITNESSES — REPORTED, NOT CHECKED`
heading, with that mechanism beside them, and no value of either can fail a run. **Do not re-add the
gate:** the statistic that answers the same question without firing on healthy runs is A2b, over the
median, and the proof that moving to it was not a weakening is that the rate-limited control still
fails seven clauses and still gets NO VERDICT.

## What is where

| file | job |
| --- | --- |
| `probe.py` | binds `scripts/serve.py`'s Handler on the **repository root**, launches one fresh Chrome per cell through `scripts/cdp.py`, asserts quiescence, prints the table, writes `results-*.json` |
| `loop.mjs` | the program a process runs. Userland: it reaches the system only through `syscall()` |
| `summarise.mjs` | the one place the withholding rule, the quantum band, the gates and the verdict live |
| `bars.json` | bench policy, not ABI: the bars, the liveness margin and the quiescence limit |

## What the run establishes

- **Isolation, in every agent.** The page aborts before producing a figure if
  `crossOriginIsolated` is not true, and `--no-isolation` is the proof that path is taken. No
  Chrome flag props `SharedArrayBuffer` up: without COOP/COEP it is genuinely `undefined`, which
  is what `scripts/serve.py` says and now what the control prints.
- **One copy of the ABI, measured.** The page, the kernel and every process report
  `ABI_FINGERPRINT`, and the bench asserts they are equal. A stale or second copy of `src/abi.mjs`
  shows up at boot rather than as a wrong errno months later.
- **One copy of FNV-1a, pinned to a published vector.** The kernel's sink and every process hash
  the same byte stream with the same implementation, in `src/abi.mjs`. Two hand-synced copies would
  drift together and the comparison would become a tautology, so what protects it is
  `selfTest()`'s known-answer vectors — `""`, `"a"` and `"foobar"` against the constants on
  <http://www.isthe.com/chongo/tech/comp/fnv/>. Changing the prime by one bit fails the load:
  `abi.mjs selfTest: FNV-1a("a") is 3863307380, not 0xe40c292c`.
- **The clock, measured this run, in every process.** The quantum is the smallest non-zero
  `performance.now()` delta over 200,000 reads, taken per process; the processes must agree, the
  histogram is binned at that width, and the probe refuses to report at ≥ 20 µs. A non-isolated
  context clamps to 100 µs, at which most of a ~14 µs region times as zero.
- **Achieved concurrency, from three biased estimators.** `G_INFLIGHT` sampled at dispatch entry
  (dispatch-weighted), Little's law from the kernel's own rate and the processes' own mean
  (time-weighted), and the per-process duty cycle. They disagree differently, so agreement between
  them is information.
- **Byte-exactness.** The kernel's sink keeps an FNV-1a over everything it consumed and each
  process keeps one over everything it intended to send. A sink that ignored the buffer would pass
  a latency test while transferring nothing.
- **Both edges of `MAX_INLINE`**, and the raw bypass: `0`, exactly 65,404 in one call, 65,405 in
  two through the short-count loop, 1 MiB in exactly 17 calls, and a raw length of 65,405 refused
  `-EINVAL` with the kernel's byte counter unchanged.
- **Both edges of constraint 46.** A 500 ms sleep against a 50 ms re-arm faults nobody; a
  terminated kernel worker faults everybody, inside `REARM_MS × (HB_MISS_LIMIT + 1)` plus 20%.
- **The instrumentation's own cost**, as a paired row — see below.
- **That a process fault is visible.** The kernel handles `{t:'fault'}`, names the pid and the
  stack the instant it arrives, and the cell reports `INVALID`. `--fault-index 0` is the control:
  it returns in 1.5 s where the swallowed version waited out a two-minute timeout with `dropped 1`
  as the only trace.

## The designed trade, where the reader meets the `-EIO`

A kernel that is **alive but synchronously busy** for longer than `REARM_MS × HB_MISS_LIMIT` =
**150 ms** is declared dead by every parked process, and `getpid` starts returning `-EIO`.
Constraint 46 leaves no alternative — a timeout alone must never fault a process, so the heartbeat
is the only liveness signal available — which makes 150 ms a **hard ceiling on any synchronous
kernel work**, M2's flush and M2's snapshot included. Reproduced with `--stall-us 200000`:
`hostGone 2`, `getpid` → `-EIO`, and the harness reports `identity BROKEN (run INVALID)` rather
than a clean number. The probe prints this sentence in its header and again beside any non-zero
`hostGone`.

## The instrumentation's cost

`--overhead` runs each N twice, instrumented and `--no-depth`, in separate fresh browsers, and
prints the delta. **The headline p99 is always the instrumented number** — the slower, honest one.

The per-call mean and the p99 are the wrong instrument for it: the device is two atomic loads and
two histogram increments, tens of nanoseconds against a 5 µs clock quantum, so their difference is
dominated by run-to-run variance (measured mean deltas of −2.9 µs to +6.7 µs, p99 deltas of
±160 µs — noise, and sometimes the wrong sign). The reciprocal of the kernel's aggregate throughput
resolves it. Two paired runs, `--n 16,32 --window-ms 2000 --runs 2`:

| N | run 1 | run 2 |
| --- | --- | --- |
| 16 | +0.107 µs/dispatch | +0.255 µs/dispatch |
| 32 | +0.055 µs/dispatch | −0.973 µs/dispatch |

At N=16 both runs are positive and both are a fraction of one clock quantum. At N=32 the sign is
**not resolved** in two runs: one `--no-depth` cell ran 18% slower than its instrumented twin. More
pairs would settle it; two do not.

## What it does NOT establish

- **Anything about another machine, build or browser.** One Chrome build, one macOS, one M2 Pro,
  headless.
- **Behaviour above 128 processes.** The cap is 128 at M0 and the renderer's own limit was not
  approached.
- **`MessagePort` dispatch fairness as a property of Chrome.** The fairness row is an observation
  of one run. Dispatch order across 128 ports is not specified to be fair, and if it fires the
  remedy is drain-the-port batching or one shared arrival ring — not sharding. Batching is
  deliberately absent from M0: one task per syscall is the honest baseline.
- **The natural "not-equal" rate as a property of the browser.** It is reply-latency dependent and
  will drift with every kernel change, so it is tallied and never asserted against a frequency.
  `--force-not-equal` is what actually exercises the path.
- **That constraint 17's cap is enforced.** It counts kernel-spawned processes only. A process can
  construct its own worker at depth 3 holding the kernel's SAB and able to block — a worker the
  table never sees. M6's realm lockdown is what makes the count the real one, and because programs
  are loaded with dynamic `import()`, M6's scope has to include the program-loading path and not
  only constraint 41's list of global names.
- **The heartbeat tick gap above 128 ms.** It is a bounded histogram — 0.5 ms bins, 256 of them,
  fixed in size whatever the run length, because the growing array it replaced reached 403 entries
  in a 4 s probe and was copied whole into every message. A gap past the top bin is reported as
  `p99 > 128 ms` with the count and the max beside it, never clamped to the top bin. 128 ms is
  chosen to cover the 150 ms busy ceiling, which is the range where the question matters.

## The negative controls

Each is a flag on `probe.py`, resolved once at kernel or process boot by swapping a dispatch-table
entry — never a per-call branch, so the headline path contains no control branch at all. Each is
scored on **which** expectation moved, because a control satisfied by any failure never verifies
its own subject.

| control | flag | must fail | must hold |
| --- | --- | --- | --- |
| kernel-stall | `--stall-us 2000` | the latency (mean 31,773 µs ≈ N × 2 ms, 100% over the bar) and the echoed `cfg` | every concurrency gate, the accounting identity, the checksums, zero heartbeat faults |
| rate-limited | `--think-us 2000` | seven of the nine clauses — A2a, A2b, A2c, A3, A4, A5, A8 — and so the verdict: NO VERDICT | **the latency must not collapse**: p99 95–510 µs over four runs, 4–20× under the kill bar, against 8,270 µs for the busy-spin version. A7 and A9 must still pass: the windows did overlap and the counters do agree |
| truncate-overflow | `--truncate-overflow` | the write checksum and the byte accounting | the latency and concurrency rows |
| kernel-dead | `--park-ms 5000 --kill-kernel` | every parked process returns `-EIO`, N of N, inside the death threshold + 20% | — no window is measured on this path |
| slow-reply | `--park-ms 500` | nothing. Zero processes may fault | everything |
| spawn-then-park | `--spawn-then-park` | `boot.ready`, fast, named `kernel-starved-children`, cell `INVALID` — never by hanging | — |
| process-fault | `--fault-index 0` | the cell, `INVALID`, with the pid and the stack named in ~1.5 s | — |
| stale-renderer | `--reuse-browser` | the quiescence assertion, from the second cell on | the first cell |
| wrong-root | `--wrong-root` | the module-graph preflight, naming all ten 404s | — |
| no-isolation | `--no-isolation` | the whole run, with no figures printed | — the declared unmeasurable outcome |
| over-cap | `--over-cap` | the cell, `INVALID`, named as the cap: "spawn refused by the hard cap at process 129; cap is 128, constraint 17" | — |

The over-cap control exists because that error path was once mislabelled. `--n 128 --hb` asks for
N + 1 processes — the heartbeat observer is a real process in a real slot — so it asked for 129
against a 128-slot table, three runs out of three, and the refusal surfaced as
`kernel-starved-children: 128/129 ready in 10000 ms; the kernel did not yield between spawn and
first use`. That diagnosis was false: the kernel yielded, the 129th process was refused by
constraint 17's cap exactly as specified, and the children that were never created cannot report
ready. Two fixes: the kernel now returns early on a refused spawn and names the cap
(`src/kernel/kernel.mjs`, `capRefusedWhy`), and the page clamps N so that N + observer can never
exceed the cap, printing `N=127 CLAMPED — …` beside the figures rather than relabelling them
silently (`www/m0.html`). The clamp is what makes an over-cap request unreachable by accident,
which is why this control is here to keep the refusal path exercised.

`--expect-invalid` inverts the exit code for the five controls whose subject is an `INVALID` cell,
so "the control fired" is an assertion and not a reading of the log. It fails when nothing is
invalid: `--smoke --expect-invalid` prints `IT DID NOT, and that is the failure`.

Plus: a lint that greps `src/kernel/*.mjs` for `Atomics.wait`, asserts the string **does** occur in
`src/libos/syscall.mjs`, and runs the detector against a fixture containing the string so it is
shown capable of firing.

Plus: the counter-agreement figure, which is now **gate A9** rather than a number nothing read. The
kernel's "notify woke nobody" count and the processes' "not-equal" count are two counters on
opposite sides of the boundary measuring one phenomenon (constraint 7). The printed figure is
**agreement**, so identical counters read 100%, and it is `null` — "nothing to agree about", printed
`n/a` and not gating — when neither side saw the event. `summarise.mjs`'s `agreementSelfTest()` runs
it at four known inputs (29/29 → 1, 0/29 → 0, 15/30 → 0.5, 0/0 → null) and the probe prints the
result, because a ratio nobody has seen move is not a check. The figure it replaced computed a
*disagreement* and printed it as agreement, so no value of it could fail. See the gate table above
for what A9 does **not** have: an end-to-end negative control.

### Resolved: the rate-limited control now produces its contrast

The design expects `--think-us` to fail the concurrency gates while the p99 **does not collapse** — that
contrast is the whole argument for the anti-vacuity devices, and it is what proves a rate-limited
harness would be caught rather than reporting a clean p99 at "N=16" while the kernel never queues
more than one call.

It did not hold while the think gap was a `performance.now()` busy-spin: sixteen spinning workers
on twelve cores starved the kernel and the p99 went to 8,270 µs along with the gates. The gap is now
an `Atomics.wait` on `IDLE_PARK` — a reserved SAB word nothing ever writes or notifies, so the wait
always times out — which is genuinely idle and costs no syscall. A `clock_nanosleep` gap would have
put one extra round trip per iteration inside the thing being measured.

Measured three times, `--n 16 --window-ms 1000 --warmup 500 --think-us 2000`. Seven clauses fail in
every run (A2a, A2b, A2c, A3, A4, A5, A8: `depth_p50` 0, `little` 0.013–0.018, `duty_min`
0.012–0.016, `q_frac` 0.000, the window never saturated), and the latency holds:

| run | mean | p99 | max | over the 500 µs bar | calls |
| --- | --- | --- | --- | --- | --- |
| 1 | 31.6 µs | 105 µs [100, 110] | 435 µs | 0 of 6,674 | 6,674 |
| 2 | 43.1 µs | 225 µs [220, 230] | 5,465 µs | 35 of 6,590 (0.53%) | 6,590 |
| 3 (after the gate ruling) | 31.9 µs | 95 µs [90, 100] | 260 µs | 0 of 6,653 | 6,653 |
| 4 (after the gate ruling) | 70.9 µs | **510 µs** [505, 515] | 2,635 µs | 71 of 6,473 (1.097%) | 6,473 |

Runs 3 and 4 are the test of the ruling: the clause that fired on healthy runs is gone and the
control still gets `NO VERDICT — anti-vacuity gates failed: A2a · A2b · A2c · A3 · A4 · A5 · A8`,
while the clean N=16 cell on the same code gets `ACCEPT — p99 210.0 us + 1 quantum < 500 us`.

**Run 4's p99 crossed the 500 µs accept bar, and that is left standing rather than re-rolled.** The
control's p99 is ~65 samples deep at this call count and has now moved 95 → 225 → 510 µs across
runs; a process idle for 2 ms is cold and its wake cost dominates. What the control is for still
holds — the latency did not *collapse* the way the busy-spin version's 8,270 µs did, and it is 4×
under the kill bar — but "the latency stays under the accept bar" is **not** a property of this
control, and a sweep that quoted its p99 as a figure would be quoting noise. That is the reason the
gates, not the latency, decide.

Against **8,270 µs** with the busy-spin, and 150–300 µs for the same N saturated over six clean
N=16 cells taken today (`--window-ms 1000 --warmup 2000`). The contrast is
produced: the gates catch the vacuous load while the latency does not collapse.

The think time was never inside the timed region: `think()` is called at the top of `syscall()`,
before `t0`. `initSyscall` also refuses to install a think gap if `IDLE_PARK` is non-zero, because
an `Atomics.wait` on a changed word returns immediately and the control would rate-limit nothing
while appearing to work. The gap is doing its job: 6,590 calls over 1 s across 16 processes is
2.4 ms per iteration against a 2 ms gap.
