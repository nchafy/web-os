# Learning mode — option D

A second purpose for the same artifact: an interactive drill-down into every operating-system
principle, against the *running* system rather than an animation of one.

Scoped as **option D** in `../PLAN.md`. It follows the spine and must not precede M0.

---

## 1. The thesis

Every interactive OS tutorial animates a fiction — a cartoon page table, a fake scheduler with
fake processes. They are fiction because instrumenting a real kernel is hard and showing it in a
browser is harder.

web-os *is* a real kernel in a browser, so its views read actual state: the real process table,
the real fd tables, the real syscall stream, the real inode table. A `top` showing processes that
genuinely exist. An `strace` showing calls that genuinely happened, at their genuine 14 µs.

Two consequences that make this sustainable rather than a side project:

- **The views are the debugger and the test harness.** One mechanism, three uses. A separate
  simulator would rot within a month of the kernel changing; an instrumented view breaks loudly,
  because it reads real structures.
- **The views prove the boundary.** Every view is an ordinary userland process using the same
  syscalls as any app. If the debugger needs a privilege it cannot express as a normal syscall,
  the boundary is fiction. That makes the learning layer a *test of the architecture*, which is
  why it belongs in this repository rather than beside it.

## 2. Where the honesty line sits

A view that animates a fiction is a cartoon. A **device with a declared timing model, where
everything above it is real code genuinely subject to that timing, is not** — it is an emulated
device, which is what every emulator has.

So three categories, and each page states which it is:

| | |
| --- | --- |
| **Instrumented** | The view reads real kernel state. Nothing is modelled. |
| **Emulated** | The mechanism is real; a *timing* or a *device* is modelled. The model is declared on the page, and where possible it replays a measured distribution rather than an invented one. |
| **Simulated** | Nothing of this exists in web-os; the page runs a standalone model to show the algorithm. **Visibly fenced off** from the other two. |

Only the scheduling-policy comparison pages are simulated, and only in tier 1.

**Three limits are declarable and must be stated wherever they bite:**

1. **Performance characteristics are not faithful.** Mechanism and policy are; a TLB miss on
   silicon costs ~100 cycles against an L1 hit's ~4, and in an interpreter both cost "some
   JavaScript". Synthetic cycle charges give the *shape* of a curve and are labelled synthetic.
   No "why is this cache-hostile loop slow" lessons.
2. **No real network protocols against real hosts.** The browser is the NIC and the TCP stack;
   this OS sits above it. That is a layering lesson, not a gap to paper over.
3. **No real hardware quirks.** Device errata, firmware bugs, timing races. Out of scope.

## 3. Feasibility — measured, 2026-11-12

Chrome 157.0.0.0 headless, macOS 26.7.2, Apple M2 Pro, dpr 2, `crossOriginIsolated` asserted true.
Harness: `../bench/feasibility/` (`bench.html`, `run.py`), raw output in `results.json`.

| Question | Result | Consequence |
| --- | --- | --- |
| Is a JS RV32I interpreter fast enough to be a teaching CPU? | **455 MIPS** (50 M instructions in 110 ms, decode-and-execute from memory) | Yes, by an order of magnitude. Roughly a 1990s workstation — a real tier, not a curiosity. |
| What does a `Proxy`-based software MMU cost? | **66× slower** (262 ms vs 4 ms for 2 M read+writes, checksums matching) | **Kills the cheap VM path.** There is no cheap virtual memory; it requires the interpreter. |
| Can an always-on trace ring be afforded? | **4 ns/record** — 0.03% of a 14 µs syscall, 0.06% at two records per syscall | Yes. Tracing is always on. A 1 MiB ring holds 32,768 records and wraps every 0.5 s at full rate, so the scrubber needs ≥16 MiB and a dropped-record counter. |
| Does the kernel-spawns-process futex handshake hold? | **p50 10 µs, p95 25, p99 30, max 840** over 20,000 round trips to a *nested* worker | Confirmed, and consistent with the 14–16 µs in `research/gap-04.md`. |

The second result is the useful one: it is a negative that *simplifies* the plan. Since a Proxy
MMU costs 66× and the interpreter gives a real MMU at 455 MIPS, there is no reason to build the
cheap one. Two options collapse into one.

**Caveat on the 455 MIPS figure:** the benchmark is a 5-instruction loop with a hot dispatch path
and good branch prediction. A real program with more instruction variety and more memory traffic
will be slower — plausibly 100–200 MIPS. Still ample. Re-measure against the first real binary
rather than trusting this number for a workload it did not run.

## 4. The two tiers

```
Tier 1   the real kernel        Workers, real syscalls at 14 µs, OPFS.
                                Real — but no MMU, no preemption, no devices.

Tier 2   the emulated machine   RV32I + Sv32 paging + timer + trap handling + a device bus.
                                Synthetic devices attach here. Virtual memory, preemption,
                                fork, context switching — all genuine mechanisms.
```

**Both tiers' processes get a pid, appear in the same `/proc`, and answer to `kill`.** That is not
a compromise; it is the lesson. It is exactly the native-versus-virtualised distinction real
systems have, and seeing `ps` list a Worker-backed process beside an emulated one — with a
page-fault count the first cannot have — teaches the difference better than prose.

**Use RV32I**, not an invented ISA: ~40 instructions, clang targets it, the binaries are real, and
xv6 — the teaching kernel OSTEP's own labs use — has a RISC-V port. Sv32 paging, `mtime`/`mtimecmp`
timers and the `mtvec`/`mcause`/`mepc` trap registers are all specified. You implement a real
machine.

**Tier 2 makes the rest honest.** With a real trap mechanism, a synthetic device raising a
completion interrupt *is* interrupt-driven I/O — the interrupt vectors through `mtvec`, saves
`mepc`, runs a handler. Only the device is synthetic. Same for DMA: implement one device twice,
once copying through a data register and once writing into a shared buffer, and the difference is
real code with a real instruction count.

## 5. External devices

**No visitor needs to own hardware.** No WebSerial, no WebUSB — those require a dev board.

Storage devices are **providers behind one interface**, declared as data rather than written as
code:

```
{ id, url template, range strategy, max object, auth: 'none' }
```

Adding a provider is a row, not a driver. That is both sustainable and the driver-abstraction
lesson as working code.

**Measured 2026-11-12** — whether each host can actually serve a block device:

| Host | `Range` | CORS | |
| --- | --- | --- | --- |
| `raw.githubusercontent.com` | 206 + `Content-Range`, exact | yes | **works, free, no account** |
| `cdn.jsdelivr.net` | 206 + `Content-Range`, exact | yes | **works, free, CDN-backed** |
| `unpkg.com` | ignored it — 999 B for a 100 B request | yes | **unusable** |
| `storage.googleapis.com` | 206 + `Content-Range` | no ACAO on that public object | works with your own bucket + CORS |
| `s3.amazonaws.com` | 403 — the dataset I probed has moved | — | **inconclusive; my probe was wrong** |
| `ipfs.io` | empty response | — | **inconclusive**, likely rate-limited |

So the default external device is **free and account-less**. One owned bucket (R2, for zero egress)
supplies the latency distribution, the live comparison, and the hot-unplug demo.

**What a real bucket buys that a knob cannot: the tail.** A fixed 50 ms teaches the mechanism; a
real bucket teaches that I/O latency is a distribution with a long tail, and "tail latency is what
kills you, not median" is invisible with a fixed delay. So: measure it, **commit the distribution
with its harness**, and have the synthetic device replay it. The model is then measured rather than
invented, and the lesson needs the measurement, not the uptime.

**The bucket is the external device**, and it supplies the thing USB was going to: **hot-unplug.**
Turn off wifi mid-read and watch a request in flight, a partially filled buffer, a retry, a
timeout, and `EIO` propagating up through the cache to the process. That cannot be done with OPFS.

Every provider is an **optional driver that degrades to the synthetic device**, with the fallback
stated on the page. More providers means more things that can be down.

## 6. Two hard constraints this introduces

**`mount` must never accept a caller-supplied URL.** A provider id plus a path, resolved against
the committed config, and nothing else. Otherwise every process gets an SSRF primitive to probe
your network from your browser's position — and M6 deletes `fetch` from processes precisely to
prevent that.

**The provider table needs a CI capability probe.** A provider that silently stops supporting
`Range` or CORS would make a page show a clean picture of a broken device. The probe is the test
run by hand above; it belongs in the suite so the build fails instead.

Before writing the R2 bucket policy, CORS config or public-read ACL: load the `builder-security`
skill and check ARCC. Three things to settle there — that public-read is scoped to exactly those
objects and nothing else shares the bucket, that CORS is restricted to the project's origins
rather than `*`, and that a budget alarm exists even with zero egress.

## 7. The page template

Every page, identical structure, so the shape itself teaches. Mockup: `../mockups/learning-mode.html`.

```
1  The principle      textbook-accurate, ~200 words, linked to the OSTEP chapter
                      and the Wikipedia section. OSTEP is linked, never copied.
2  Verdict            ● live  ◐ partial  ◑ inverted  ○ absent, plus one sentence of why,
                      and the honesty category from §2
3  Drill-down         the live view against the running system
                      — or, for ○, the essay on what is missing and what it costs
4  Try it             real commands, in a real shell
5  On real hardware   what Linux does differently, and why
6  The check          the assertion that fails if this page stops being true
```

**Line 6 is what stops the whole thing rotting: every page is a CI check.** A page claiming the
journal reports its discarded tail runs that scenario and asserts it. When the kernel changes, the
lesson fails the build rather than quietly lying.

## 8. Coverage

Full matrix in `../mockups/learning-mode.html` (Coverage matrix tab), indexed to Wikipedia's
[Operating system § Components](https://en.wikipedia.org/wiki/Operating_system#Components) and
drilled to [OSTEP](https://pages.cs.wisc.edu/~remzi/OSTEP/) chapter depth.

**22 live · 8 partial · 2 inverted · 3 absent — 35 pages.** Every component on the Wikipedia list
is live or partial; nothing on it is absent. The three absent pages are flash/SSD,
authentication and cryptography.

Two topics are worth naming because neither appeared on the original list:

- **Trap vs interrupt** is the most illuminating page available. A syscall on x86 *is* a software
  interrupt trapping into ring 0; here it is `postMessage` plus a futex park. Both are "stop being
  me, start being the kernel" — one via a privilege transition, one via a thread handoff.
- **Free-space management is separable from virtual memory.** OSTEP ch.17 is pure algorithm, so a
  real allocator in-process — first-fit vs best-fit, live fragmentation map — is fully faithful
  even with no MMU. Eleven VM chapters collapse to one honest essay; ch.17 survives intact.

And one where web-os is the reference implementation rather than a degraded case:
**event-based concurrency** (ch.33). Worth leading the Concurrency section with, because it
establishes that the absences are specific rather than general.

## 9. Cost

| | |
| --- | --- |
| **Fold into the spine** | |
| `/dev/trace` ring + dropped-record counter | 1 d — into **M3** |
| `top`, `strace` as real programs | 2 d — into **M5** |
| **Tier 2: the teaching machine** | |
| RV32I interpreter | 4 d |
| Sv32 MMU, page tables, TLB, faults | 3 d |
| Traps, interrupts, timer | 2 d |
| Scheduler + 4 swappable policies | 3 d |
| `fork`, COW, demand paging to OPFS | 3 d |
| Device bus + 5 synthetic devices | 4 d |
| PIO vs DMA as two implementations | 1 d |
| Prebuilt RV32I lesson binaries | 2 d |
| **Devices and distribution** | |
| `blockdev` interface + provider table + 2 free providers | 2.5 d |
| Latency harness, committed distributions, replay | 2.5 d |
| Hot-unplug page; multi-provider comparison | 2 d |
| Cross-provider RAID | 1.5 d |
| Two tabs over `BroadcastChannel` + minimal NFS | 3 d |
| R2 bucket + CORS + policy (after the security pass) | 0.5 d |
| **The layer itself** | |
| Page harness, scrubber, check runner | 6 d |
| 35 pages | 14 d |

**Spine additions: 3 d. Option D: ~57 d.**

## 10. Sequencing

**Option D comes after the spine. It must not precede M0.** If the emulator is built before the
syscall channel is proven, the outcome is an excellent RISC-V machine and no operating system.

The 3 days that fold into M3 and M5 are the exception, and they pay for themselves immediately:
a live syscall histogram on day 3 is a better M0 deliverable than a number in a terminal, and for
the first 30 days the views are the only visible thing.

Within option D the order is risk-first, as everywhere else:

| | | |
| --- | --- | --- |
| 1 | RV32I interpreter + one real binary | re-measure MIPS against a real workload, not the 5-instruction loop |
| 2 | Sv32 MMU | the single biggest coverage gain |
| 3 | Traps + timer + scheduler | unlocks preemption, which unlocks everything else |
| 4 | Device bus + providers | needs nothing above |
| 5 | Pages | last, because they assert against finished mechanisms |
