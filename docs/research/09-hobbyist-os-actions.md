# Distilled: what the hobbyist-OS survey changes

The evidence is in `08-hobbyist-os-survey.md` — 17 systems from
<https://en.wikipedia.org/wiki/Hobbyist_operating_system> plus BeOS/Haiku, read from their own source
and documentation. This file is the actionable residue: what to change, what it costs, and which
constraint or milestone it lands on. Nothing here is normative until it is accepted into
`../CONSTRAINTS.md` or `../DECISIONS.md` — the numbering below is a proposal.

Ranked by how much each item changes the plan. Items marked **before M0** or **before M2** are
sequencing claims, not urgency theatre: they are cheap now and expensive later.

---

## The five that matter

### 1. M0 cannot see the risk it exists to measure · **before M0** · +0.5 day

M0 saturates the kernel with `getpid`, `write(1, …)` and `nanosleep`. None of them touch OPFS. But
the kernel's fast VFS path is **synchronous OPFS calls on the kernel's own thread** — 495 µs
`createSyncAccessHandle` (22), 260 µs `flush()` (23), 0.60 ms per name on Safari (33) — and the kernel
is the only thread in the system. That is head-of-line blocking for all 128 processes, not just the
caller, and the chosen workload is the one workload that cannot exhibit it.

Three systems converge on the rule: HelenOS holds a per-fd lock across a downstream call so one
client's slow read does not block another's `stat`; SerenityOS splits any slow request into a ticket
plus an async completion with a cancel message; Orbital parks a request it cannot satisfy on the
*resource* and replies out of order. The rule is **a syscall that must wait must not hold the kernel
thread.**

Do: add a fourth call to M0 that opens and writes a real OPFS file, run the mix at N ∈ {1, 16, 64},
and report p99 for the cheap calls *while* the expensive ones are in flight. Specify the queue drain
order while you are there — HelenOS drains notifications, then answers to in-flight calls, then new
requests, which is the standard livelock defence and the cheapest way to turn a bad p99 into a good
one without sharding. Add a sampling profiler of the kernel worker and a two-revision comparison
mode (Redox's harness shape), so a bad number is attributable to a handler and a regression to a
commit.

If this fails, the answer is not necessarily a sharded kernel: it may be a second kernel-side I/O
worker owning the OPFS handles, which is a smaller change than M0's stated fallback.

### 2. A process is single-threaded by construction, and nothing says so · **before M0** · free

One futex word, one outstanding call, and M6 deletes `Worker` from the process realm (41). So a
process can never have two operations in flight: no coroutine runtime doing background I/O, no
decode while the UI services events, and none of the "looks synchronous, actually pumps the event
loop" idioms that SerenityOS's entire GUI client library is built from (`Promise.h`,
`Dialog::exec()`). HelenOS needed fibrils because its channel was async; we need nothing because
ours blocks — and the symmetrical cost is that HelenOS can run other work while one operation is
outstanding and we cannot.

Constraint 20a's `f | g` deadlock is a **special case** of this, and its remedy — budget a second
shell worker — is the general remedy: concurrency inside an app costs a second process, charged
against the cap. That changes the cap arithmetic for every app nobody has designed yet, and it makes
`await prompt()` written as straight-line code inexpressible. Write it down before an app is designed
around the assumption that it works.

### 3. The ABI has no mechanism for growing, and three systems say that is the expensive mistake · **before M1** · ~1 day

- **AROS** declares each library's whole interface in one `.conf` file and *generates* the stubs, the
  vector table, the headers and the prototypes from it, with `.skip N` to retire a slot without
  renumbering and `.version N` to mark later additions. Its ABI v1 break — a one-year estimate that
  was still producing forks a decade later — was entirely **representation** decisions: where a handle
  lives, what unit a pointer counts in, how state is partitioned.
- **Haiku** added eight `BView` methods without touching the BeOS R5 vtable, using R5's **reserved
  slots** plus one generic `Perform(code, data)` escape hatch. Its IPC frame carries a 4-byte format
  magic and it reads four dialects through one dispatcher.
- **SerenityOS** assigns message ids by ordinal position in the `.ipc` file, guards half of that with
  a CI linter, and states its ABI has "absolutely no stability guarantee".

Do, in order of value: (a) make `docs/ABI.md`'s table the **generated** artifact of one declaration
file that also emits the libos stubs and the kernel dispatch table — `CLAUDE.md` already requires one
named constant imported by both sides, and this is how that rule survives contact; (b) reserve
syscall numbers and add one `perform(opcode, struct)` escape hatch now; (c) put a format magic and a
version word in the SAB frame header (four bytes, impossible to retrofit, and the harness is a second
consumer of that format); (d) decide whether the ABI is frozen, because borrowing WASI preview1's
errno numbers verbatim is already a commitment to numbering this project does not control.

### 4. The window protocol is missing what both mature compositors have · M7–M12 · ~3 days spread

Five mechanisms, each from a system that shipped it:

1. **Repaint from server-held state.** Haiku's app_server repaints a newly exposed region itself from
   a background colour plus a cached view bitmap, "without waiting for a roundtrip to the window's
   Draw() methods", and keeps **two** alternating damage sets so damage arriving during an in-flight
   client repaint is neither lost nor merged. Without both, dragging one window over another leaves
   garbage trails for a round trip — and with no preemption that round trip is unbounded.
2. **Server-allocated surfaces.** Haiku's server allocates bitmap memory and maps it to the client;
   SerenityOS does the opposite. The two mature systems chose opposite sides, so decide on this
   project's own terms — and the terms favour Haiku, because server-allocated is the only version
   that gives **accounting and revocation**, which is exactly what constraint 49's admission
   controller and constraint 17's cap both need and neither has. A transferred `OffscreenCanvas` is
   the opposite: a one-shot handoff with no front/back pair, no serial-based flip, and no way to
   revoke.
3. **Server-drawn chrome, including menus.** SerenityOS's WindowServer owns menu layout, rendering,
   hit-testing and keyboard navigation; KolibriOS draws the frame from the system skin and makes its
   height *queryable* rather than hardcoded. With no preemption, **anything the app draws freezes
   when the app does** — so which chrome is server-drawn is a decision that determines what stays
   alive when an app wedges, and the plan has not made it.
4. **"Not responding", detected without cooperation.** WindowServer arms a 3 s timer on every
   outgoing message, pings, waits 1 s for a pong, then overrides the cursor and repaints the frames
   as unresponsive. In a system with no preemption a wedged app is the *normal* case, Windows 7
   already has the visual vocabulary for it, and the user deserves the signal before anything is
   killed. Threshold on a continuous input, so both edges get checked.
5. **A global window cap with its own errno.** SymbOS caps windows system-wide at 32 and refuses the
   33rd with a specific message. The blur budget binds on *area* (36), so there is currently no
   refusable quantity at all: a 1,000-process system can open 1,000 windows and discover the problem
   as dropped frames. An admission controller that can only degrade and never refuse is half a
   governor.

Also worth pricing, as a genuine alternative rather than an addition: **SymbOS's retained-mode
protocol**, where the client hands the compositor a pointer to a control-record tree and thereafter
says only "redraw control N". It removes per-process surfaces from the memory budget, makes the
blurred-area budget a property of the compositor alone, and keeps a wedged app's window live. It is
a worse fit for a terminal and a better fit for Explorer, dialogs and the taskbar — so the honest
shape is a hybrid, and BOOPSI plus KolibriOS plus Haiku all agree on where the line goes: the server
owns hit-test dispatch, the active-widget state machine and layout invalidation; the app owns pixels
inside a granted draw call.

One correction to `CLAUDE.md` while in here: **the taskbar cannot be an ordinary client of the same
ABI.** SerenityOS gives it a second endpoint on a separate socket with an event mask, because it
needs cross-process window enumeration no ordinary client may have, and a per-process window fd
cannot name another process's window. The honest form of the invariant is a second,
separately-gated management interface — still a capability the kernel granted, so the boundary
survives.

### 5. Data is not journalled, only metadata · **before M2** · 1 day or 1 line

File data lives in a flat OPFS directory named by inode (26), so overwriting an existing file mutates
its blob **in place**. The journal and the alternating superblocks give crash consistency for
*metadata*; a blob half-overwritten when the tab dies leaves intact metadata pointing at torn data.
That is POSIX-permissible without `fsync`, and it is exactly ext4's `data=writeback` — which is not
ext4's default, precisely to avoid this
(<https://www.kernel.org/doc/html/latest/admin-guide/ext4.html>). Phantom gives every persistent page
three blocks (`prev`/`curr`/`make`) with the rule "if page is to be written, it goes to curr ONLY".

Do one of: give data the same discipline (write a new blob, swing the reference at commit — easy
here, because the name is just an integer), or declare the guarantee metadata-only and say so where a
reader meets it. Discovering this after users have files is the bad outcome.

---

## Then, in order

1. **The durability open question has a known answer shape.** EROS/KeyKOS carries an "escape hatch"
   that commits one page immediately, outside the checkpoint, because database logs cannot wait. So
   do not try to make the whole journal synchronously durable: define durability on **one call**
   (`fsync` on one fd, which the ABI already has), measure *that*, and let everything else ride the
   snapshot. The negative control is a tab killed mid-write asserting the record survived. This turns
   an unanswerable question about the whole design (`PLAN.md` §10) into one measurement.
2. **Three harness additions, all cheap, all from systems that ship them.**
   - A **host-runnable pure kernel**: SerenityOS builds its libraries a second time for the build
     machine ("Lagom") so unit tests, sanitizers and 81 fuzz targets run in milliseconds. The inode
     table, the superblock and journal codecs, path resolution and the dispatch table should run in
     plain Node with no Worker, no SAB and no OPFS. **Journal replay is a parser over torn bytes and
     is exactly a fuzz target** — M2's control tests one hand-truncated journal where a fuzzer tests
     ten thousand. No dependencies, no build step: the same `.mjs` files, imported by a script.
   - A **self-test boot mode**: SerenityOS's PID 1 reads a boot mode and starts the test runner
     instead of the desktop, so the thing under test is the real kernel, real VFS and real WM. CI then
     boots the OS, and fails unless a result file *on persisted storage* contains the exact string
     `Failed: 0`, read back after the system is gone. Our version: write results into OPFS, tear the
     page down, reopen from a fresh context, and treat a missing or short file as failure — which
     exercises the persistence path for free.
   - A **frame corpus**: Haiku checks real captured messages into the tree and replays them through a
     tiny test. Capture syscall frames from the shell and the ten programs of M5, check them in,
     replay them. Inverts cleanly under `--prove-failure` (corrupt the magic, demand a failure).
3. **Capabilities that can only narrow.** SerenityOS's services acquire their handles and then drop
   the promise that would let them acquire more, enforced in *kernel* per-process state and checked at
   dispatch; Redox's scheme daemons enter the null namespace with `setrens(0,0)`. The credential
   already carries `caps` with nothing that uses it. A capability bitmask in the process table, a
   `pledge`-shaped call that can only clear bits, and a check at dispatch is a genuine boundary
   against a confused-deputy bug in a first-party app — which is this project's actual threat model —
   in a way that deleting `fetch` inside the worker is not. The assertion is **monotonicity**, not a
   symptom: after narrowing, every widening must fail. Constraint 41's honest label stays true of the
   realm lockdown and would not be true of this.
4. **Unsolicited events need a drain-to-empty contract.** AROS (`GetMsg` until NULL), SerenityOS (the
   self-pipe read drains an array of pending wakes) and HelenOS (a monotonic counter on every
   notification so coalescing is detectable) all say one wake covers many events. The request path is
   fine; the event path is not specified, and the kernel's per-process event backlog has no bound and
   no defined overflow — the same hole constraint 9 names for the argument buffer. HelenOS's answer to
   the bound is the cheap one: a fixed in-flight budget and a synchronous `ELIMIT` when it is
   exhausted, with the budget part of the ABI contract.
5. **Pin the browser surface in writing.** SkyOS died after twelve years because "catching up with the
   development for all this is just not possible anymore… not for one person". Its drivers are our
   browser APIs: OPFS semantics, clipboard and drag-and-drop, `backdrop-filter` across GPUs,
   `Atomics.wait`, and every Chrome release. `PLAN.md` §10 already meets this four times. Make it one
   list — the APIs and the version the spine depends on — so drift arrives as a diff rather than as a
   bug report.

---

## Proposed constraints

Numbered from 52, as amendments to `../CONSTRAINTS.md`. Each cites the section of
`08-hobbyist-os-survey.md` that carries its evidence.

| # | Proposed constraint | Evidence |
|---|---|---|
| 52 | A process is single-threaded by construction. Concurrency inside an application MUST be a second process, charged against the cap. Constraint 20a is a special case. | §2 (Redox tags, HelenOS fibrils), §1 (`Promise.h`) |
| 53 | A syscall that must wait MUST NOT hold the kernel thread. Synchronous OPFS on the kernel thread is head-of-line blocking for every process, not just the caller. | §2 (HelenOS per-fd lock), §1 (ticketed decode), §2 (Orbital delayed reads) |
| 54 | The kernel's queue drain order MUST be specified: in-flight completions before new admissions. | §2 (HelenOS answerbox priority) |
| 55 | One wake MUST drain all pending events. The per-process event backlog MUST carry a bound and a defined overflow. | §4 (AROS `GetMsg`), §1 (self-pipe), §2 (`ELIMIT`) |
| 56 | The ABI MUST be generated from one declaration. Retired call numbers MUST stay reserved, reserved opcodes and one `perform` escape hatch MUST exist, and the frame MUST carry a format magic and version. | §4 (AROS `.conf`/`.skip`), §5 (Haiku reserved slots, `'FOB1'`), §1 (`IPCMagicLinter`) |
| 57 | The superblock MUST carry a generation counter and a major/minor version, with "minor newer than me ⇒ refuse". Three generations SHOULD be retained so a bad commit leaves a good fallback. | §4 (Phantom), §2 (RedoxFS header ring), §4 (Squeak image versioning) |
| 58 | File data MUST be copy-on-write, or the crash guarantee MUST be declared metadata-only where a reader meets it. | §4 (Phantom prev/curr/make), ext4 `data=ordered` |
| 59 | The snapshot MUST validate the table before serializing and refuse to commit on failure. The stop-the-world barrier MUST NOT include the OPFS write. | §4 (Phantom verifier; L3 vs Fluke) |
| 60 | Durability MUST be measured on one escape-hatch call, not claimed for the journal. | §4 (EROS escape hatch) |
| 61 | The inode table MUST have a declared transient class with a reserved number range, destroyed unconditionally at mount, and the superblock MUST name one root record. | §4 (Phantom restart list; EROS exempt OIDs) |
| 62 | The compositor MUST be able to repaint an exposed region from state it holds, and MUST keep two damage sets per window. | §5 (`fExposeRegion`, `UpdateSession[2]`) |
| 63 | Window surfaces MUST be allocated and accounted by the kernel so they can be refused and revoked, and a global window cap MUST sit beside the area budget. | §5 (Haiku `BitmapManager`), §3 (SymbOS 32-window cap) |
| 64 | Chrome that must survive a wedged application MUST be server-drawn, and frame metrics MUST be queryable rather than hardcoded. | §1 (menus in WindowServer), §3 (KolibriOS skin, 48.4) |
| 65 | An unresponsive process MUST be detected without its cooperation and surfaced before anything is killed. Both edges checked. | §1 (ping/pong, 3 s / 1 s) |
| 66 | A capability MUST only ever narrow, no capability MAY be obtainable after boot, and monotonicity MUST be the asserted invariant. | §1 (pledge/unveil + their tests), §2 (`setrens(0,0)`) |
| 67 | `waitpid` MUST distinguish an exit code from a kill reason, and the kernel MUST record the reason at teardown. | §1 (`LibTest::Crash`) |
| 68 | Every releasable resource MUST be owned per process and enumerable, so kill is O(manifest). | §3 (SymbOS header manifest), §4 (TempleOS task-owned heaps) |
| 69 | A synchronous call that would wait on the caller's own loop MUST fail fast with a named errno. | §5 (`SendMessage` deadlock; Haiku's same-team bypass) |
| 70 | Teardown MUST be two-phase: answer every outstanding call with a defined errno, then assert the count is zero. | §2 (HelenOS `EHANGUP` cleanup) |
| 71 | An invariant MUST abort loudly in dev builds rather than be documented as a rule, and each abort owes a `--prove-failure` control. | §5 (`debugger("Looper must be locked.")`), §1 (`did_misbehave`), §4 (Phantom panic) |
| 72 | The harness MUST fail if it cannot confirm it is running the live tree, and a clean checkout MUST boot with no local state. | §5 (Syllable 0.6.7 shipped from a stale branch; AtheOS not reproducibly buildable) |
| 73 | The browser surface the spine depends on MUST be pinned in writing: the APIs, and the version. | §5 (SkyOS) |

Also worth considering, lower confidence or smaller: paths canonicalized in libos with the kernel
rejecting non-canonical (§2, HelenOS PLB); an `ENOSYS`-class return for an absent optional subsystem,
which WASI preview1's number space contains but no call in the ABI table lists (§3, EmuTOS size
tiers); a per-call policy for which of
the 68 return an errno and which fault the process (§1, `did_misbehave`); and an idle/elapsed counter
pair readable without a syscall so kernel load is observable in production (§3, SymbOS `MTGCNT`).

---

## Proposed decisions and amendments

**D7 — the window ABI.** Conclusion stands, reasoning is too narrow. Redox *did* make a window a
file, and the result was geometry smuggled through the path, commands degenerating into a
comma-separated verb language, and the pixels escaping through `mmap_prep` anyway — so a plain file
interface genuinely cannot express a window. But both Redox (`RespondWithFd`,
`RespondWithMultipleFds`) and SerenityOS (`sendfd`/`recvfd`, gated by their own pledges) solved the
handle problem in the **reply envelope**, not by forking the syscall surface. The general mechanism is
an out-of-band handle queue per process with a bounded depth and an `EAGAIN`, which serves window
surfaces, the clipboard, broker-supplied files and `shm_attach` at once. Restate D7 as "`win_*`
payloads are typed calls on an fd" rather than "a parallel syscall family".

**D12 — credentials.** Already correct and routinely misread: two independent subagents read "a
per-call argument" as forgeable. Say "stamped by the kernel at syscall entry from the process table"
wherever it appears. Two real additions: the credential needs `sid` and `pgid` (job control needs
them, and the ABI has `setpgid` with no session concept), and a multi-step path resolution should
take one immutable snapshot so a `chown` landing mid-walk cannot straddle the check.

**D16 — risk order, with the M4a exception.** The decision is fine; **the stated rationale is not
supported by the evidence.** "30 days with nothing visible is how solo projects die" is the story told
afterwards: SkyOS had by far the most visible cadence in this family — numbered builds to 6947, a
paying beta from 2003 — and stopped in 2009, while Haiku went five years and eleven months with no
release at all and is still shipping. That reading is `inferred`, n=4, and no source was found that
tests the hypothesis. The better-evidenced ground is the AtheOS record: a solo author's motivation is
a load-bearing component with no redundancy, and it failed on flying lessons, a dead PC and a fork.
So M4a is a promise to the author, not to an audience — and the same evidence says the plan must
survive a multi-week gap, which is why `MILESTONES.md`, `DECISIONS.md` and `PLAN.md` §10 are worth
their maintenance cost.

**New D17 — window surface ownership.** Kernel-allocated retained surfaces with a serial, versus the
transferred `OffscreenCanvas` of M8. Haiku and SerenityOS chose opposite sides; the accounting and
revocation argument favours kernel-allocated here, because two budgets (blurred area, renderer
memory) currently have no mechanism.

**New D18 — retained-mode controls.** Whether the window protocol carries a control-record tree
redrawn by control id (SymbOS, BOOPSI, KolibriOS) alongside an immediate-mode surface, and where the
line goes. This is the one finding that could reduce the window half's cost rather than add to it.

**New D19 — journal versus header ring.** RedoxFS has no journal: copy-on-write data plus a
256-entry ring of self-validating headers with a monotonic generation, recovered by scanning for the
highest valid one. No replay path to write and no torn-tail semantics to test. Against it: our
metadata is small and numerous, and a journal makes a 10-byte edit cheap. Price it in M2 days 5–8
rather than later. Either way, 57 applies.

**New D20 — is the ABI frozen?** Borrowing WASI preview1 errno numbers verbatim is already a
commitment; nothing else is stated. The answer decides whether a retired call number may be reused,
and therefore whether 56 is needed now or later.

**New D21 — there is no reload story, and here is what one would cost.** Phantom's mechanism is the
only one in the survey: a syscall is *restartable*, with the instruction pointer rewound so the call
re-executes after restart. The price is an **idempotency requirement on every blocking call** —
`write` at an implicit offset is not idempotent, `pread` is — and the reference implementation never
solved reconnecting external resources at all (its TCP syscalls throw "not implemented" two decades
in). Record that process-survives-reload is out of scope by decision, not by omission.

---

## Milestone deltas

| Milestone | Change | Cost |
|---|---|---|
| Harness (before M0) | Host-runnable pure-kernel test target; journal-replay fuzzer; frame corpus; live-tree assertion | +1.5 d |
| M0 | A fourth, OPFS-touching call in the saturation mix; specify queue drain order; kernel-worker profiler; two-revision compare | +0.5 d |
| M1 | Kill reason recorded at teardown and reported by `waitpid`; per-process resource manifest; two-phase teardown with a final assertion | +0.5 d |
| M2 | Superblock generation + major/minor version; snapshot-time validator; barrier excludes the OPFS write; transient inode class; decide 58 (CoW blobs or metadata-only); price D19 | +1.5 d |
| M3 | `/proc` and `/dev` are the transient class, not a special case; service/PID-1 ownership of startup and restart policy | +0.5 d |
| M4 | `SIGTTIN`/`SIGTTOU`, `SIGHUP` on window close, session id | +0.5 d |
| M6 | Capability bitmask + narrowing call + dispatch check, with the monotonicity assertion; state which code is allowed inside the compositor realm | +1 d |
| M7–M9 | Exposed-region repaint from server state; two damage sets; destroy-cascade reported; cross-process owner identity `(pid, winid)`; second gated management interface for the taskbar | +2 d |
| M8 | D17 decision; batched command path plus a separate large-payload path | +1 d |
| M11–M12 | Server-drawn chrome decision; queryable frame metrics; global window cap with its own errno; "not responding" ping/pong with both edges checked | +1 d |

Roughly **+10 working days** on a 70-day plan, of which the first four lines are the ones that
prevent rework rather than add surface.

---

## What the survey confirms, with no action

Recorded because a confirmed decision is worth as much as a corrected one, and because these are the
questions a future reader should not reopen.

- **`poll()` as the single wait primitive over fds** — SerenityOS's event loop is exactly this, with
  a self-pipe as the first entry, and `EINTR` simply re-polls. D8 and constraint 42 stand.
- **Kernel-driven cancellation** — a subagent read the ABI as making `EINTR` unimplementable; it is
  wrong. `ABI.md` §1 already sets SIGPEND, sets `STATUS=2`, bumps `SEQ`, notifies, aborts the host
  work via `AbortController` and drops the late reply by CALLID. Redox's `Cancel` and HelenOS's
  `EHANGUP` are the same design. The residual is the already-recorded weak point: a worker inside a
  *synchronous OPFS call* is not in `Atomics.wait`.
- **Pipes kernel-owned, and time/memory/event multiplexing in the kernel** — Redox keeps exactly
  these eleven schemes in its kernel, including `pipe`. Constraint 15 stands.
- **Readers see EOF, writers see EPIPE** — unchanged, and the two-direction asymmetry is standard.
- **A bad image mounts read-only and never reseeds** — Phantom, the only implementation of
  orthogonal persistence in the set, never finished its repair path and chose to halt. D11 is the
  same decision, independently arrived at.
- **The ~2 s quarantine against pid reuse** — TempleOS holds dying tasks on a queue for
  `DYING_JIFFIES` for the identical reason ("lingering ptr to reincarnated"). Constraint 14 stands.
- **A hard process cap derived from a sized table** — KolibriOS's 256 slots are two independent
  constants that agree, with `assert sizeof.APPDATA = 256`. Constraint 17 stands; make the number one
  named constant that also sizes the SAB array.
- **O(interested), never O(N)** — KolibriOS moves pooled 32-byte events between per-thread FIFOs by
  pointer only, and SerenityOS broadcasts the whole theme as one shared buffer every client maps.
  Constraint 18 stands and now has a data structure.
- **Spine-first ordering** — in the solo-OS record it is the *userland surface* that gets starved,
  not the window manager: AtheOS had an appserver, a browser and a journalled filesystem after five
  years and no CD-ROM support.
- **Synthetic filesystem introspection** — SerenityOS serves its whole process table as JSON at
  `/sys/kernel/processes`, read by `ps`, the system monitor and the taskbar. M3's `/proc` argument,
  confirmed, with the caveat that generated-on-read nodes are a different code path from
  OPFS-backed ones.
- **No `mmap`** — HelenOS's pager is one synchronous IPC per page with an unfinished coherency story
  after twenty years. Leaving it out is defensible; Syllable's experience says state the consequence
  (it was stuck below GCC 4.1 for want of it).
- **70 days is credible only because the browser supplies the substrate** — hardware, scheduler,
  network stack, renderer, font engine. Worth one sentence in `PLAN.md`: the 70 days buy the
  abstractions, and any milestone reaching below the browser is out of scope by construction.

---

## What this does not resolve

- **No published IPC latency or throughput figure exists for HelenOS or Redox**, and no snapshot-cost
  or restart-time measurement exists for Phantom. The 14–16 µs figure has nothing in this family to
  be compared against, and the snapshot numbers must be measured here. The only quantified checkpoint
  costs in the survey are EROS's, which that paper explicitly labels computed rather than measured.
- **Whether the single-threaded kernel survives OPFS contention** — still M0's job, now with the
  right workload.
- **Whether a retained-mode window protocol is cheaper overall** than per-process surfaces, in this
  environment. SymbOS proves it works in 64 KiB; nothing here proves it beats a canvas in a browser.
- **Whether the webxp filesystem image should import.** D1 settles that the 42 apps are not ported;
  nothing says whether an image does. KolibriOS waited two years and then broke Menuet32 binaries
  outright — "we lost little, since Menuet32 is practically not developed". Half-kept compatibility is
  what costs; decide it, either way.
- **The cadence-versus-survival reading is `inferred`, n=4.** It is strong enough to reword D16's
  rationale and not strong enough to change a decision.
