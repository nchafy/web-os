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
| — | Harness: `cdp.py`, `--prove-failure`, spine checks | 2 | 0.2 | 🟡 partial — driver and a worked example in, `check.py` not written |
| **M0** | **Prove the syscall channel under contention** | 1 | | ⬜ **next** |
| M1 | Process lifecycle, signals, hard cap | 4 | | ⬜ |
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
**Negative control:** `scripts/serve.py --no-isolation` — `crossOriginIsolated`,
`SharedArrayBuffer`, `OPFS sync handle` and `worker can block` must all go red and the verdict must
refuse.

## Harness — partial

`scripts/cdp.py` is in (380 lines: `find_chrome`, `WebSocket`, `Session`, `Browser`).
`bench/coep-tiles/probe.py` is a complete worked example of the discipline: it asserts isolation
before timing anything, and carries a negative control that fires.

**Still owed:** `scripts/check.py` with the `INVERTIBLE` tuple and `--prove-failure`, and the ~6
spine-relevant non-geometry checks adapted from the predecessor — `check_boot`, `check_mount`,
`check_mount_index`, `check_filesystem`, `check_fs_persistence`, `check_terminal`. Do this before
M2, which is the first milestone that needs somewhere to land.

---

## M0 — Prove the syscall channel under contention · next · 1 day · ~250 LoC

The one milestone that can invalidate the whole plan. The 14–16 µs syscall was measured with **one
caller against an idle kernel**; the kernel is a single thread that serializes every syscall in the
system, and contention is unmeasured.

**Build.** Kernel worker; N process workers spawned *by the kernel* as nested workers; the SAB ABI;
three calls — `getpid`, `write(1, …)`, `nanosleep`.

**Proof.** Closed-loop saturation at N ∈ {1, 4, 16, 64, 128}. No offered rate — every process
issues its next call the instant the last returns — and **assert achieved concurrency**, not just
process count. A rate-limited harness reports a clean p99 at "N=16" while the kernel never queues
more than one. Accept if p99 at N=16 is under 500 µs.

**Negative control.** Insert a 2 ms synchronous stall in the kernel handler. p99 must blow past the
bar.

**Kill criterion.** p99 above 2 ms at N=16 → stop. Do not write M1. Reconsider a sharded kernel
(one kernel worker per process group, VFS behind a lock).

**Watch for.** ~0.2% of round trips return `"not-equal"` from `Atomics.wait` because the kernel
replied before the process parked. Fast path, not an error — handle it from the first line.

---

## M1 — Process lifecycle, signals, hard cap · 4 days · ~1100 LoC

Delivers the headline: a process in `for(;;){}` with no syscalls dies on End Process.

**Build.** `spawn`, `exit`, `waitpid`, `kill`, `sigaction`, `setpgid`, `sched_yield`. Monotonic,
never-reused pids. Hard cap 128; the 129th returns `-EAGAIN`. Signals through the SAB control word
(16). Finite re-arm interval plus a kernel heartbeat word (46). Teardown split from reap (14).

**Proof.** (a) compute-bound process dies on End Process; (b) `kill -9` under contention;
(c) the 129th spawn fails cleanly; (d) kill the kernel worker and every parked process returns
`EIO` within 2× the re-arm interval — **without reloading the page**.

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
| Is a journal append plus `flush()` durable across a kill? | before storing anything real | 1 d | The spec says "attempt to transfer" and allows a no-op. Build the zip-export affordance regardless. |
| Calibrate the blur ceiling at boot instead of hard-coding one machine's number | M12 | 0.5 d | Turns an unknown into a runtime measurement, which is strictly better than more research. |
