# web-os: continue implementation

Written 2026-11-15 by the session that built the harness through M2, and updated the same day by
the session that built M3, M4 and M4b. This file carries only what the repository cannot
tell you. Everything the repo settles, the repo settles.

## Where the work is

- **Worktree:** `/Users/chafyni/claude/web-os/.claude/worktrees/m4a-window` — M4a's work is here.
  M0–M5 are on `.claude/worktrees/m4b-flake`; `webos-impl` is one commit behind it.
- **Branch:** `m4a-terminal-window`, branched from `f59dc60` (M5 + the program-fetch fix). `main` is
  still at the scaffold `c3d826f`. Git refuses to move `main` from inside a worktree, so if the
  user wants it merged:
  `cd /Users/chafyni/claude/web-os && git merge --ff-only m4a-terminal-window`
- **Python:** `.venv/bin/python` (3.8, has `websocket-client`). **Node:** 18.20.2 on PATH.
  **Chrome:** 157.0.8103.52 — `docs/CONSTRAINTS.md`'s older figures were taken on 157.0.8103.38,
  so name the build beside any new number.

## Read these first, in this order

`CLAUDE.md` has an onboarding table — follow it. Short version: `CONTEXT.md`, then
`docs/CONSTRAINTS.md` (124 numbered constraints, **normative**, cite by number), `docs/ABI.md`,
`MILESTONES.md`. Then `docs/DECISIONS.md` before arguing with any decision.

Do not re-derive anything those files settle. They are the product of adversarial review, and
several record a specific mistake and its correction.

## Done

Harness, M0, M0a, M0b, M1, M2a, M2, M3, M4, M4b, M5 and **M4a**. Each has a record in
`MILESTONES.md` with its actual cost and what it changed in the plan. Current gates, all green:

| command | what it is |
|---|---|
| `scripts/check.py` | the suite — 9 checks, 363 expectations. Measured 2026-11-16: boot 30, syscall 31, m1 14, m2 92, m3 55, m4 23, m4b 54, m5 38, m4a 26 |
| `scripts/check.py --negative pty-detach` | M4a's control — a write to the pty master discards its bytes. 6 red, 20 intact |
| `node bench/m4a-console/probe.mjs` | 65 host checks over `/dev/console`: the queue, the parks, detach, and the detector's two edges. No browser |
| `node bench/m3-synth/probe.mjs` | 98 host checks over `/proc` and `/dev`, 13 of them `/dev/console`'s in the mount table |
| `scripts/check.py --prove-failure both` | inverts every expectation, and runs the no-isolation phase; must report failures |
| `bench/m4b-pty/controls.py` | the pty's 5 mutation controls, each scored on WHICH labels move |
| `bench/kernel-churn/probe.py` | how reliable is one kernel boot? `--n 60 --runs 6`; `--stall` proves the program-fetch deadline fires |
| `bench/kernel-churn/rangetest.py` | the byte-range server is byte-exact and refuses what it cannot serve |
| `scripts/check.py --negative <control>` | `--controls` lists what each proves. **Kill stray Chrome AND WAIT FOR IT TO EXIT between runs**, and do not run two phases at once — `pkill` returns before Chrome is gone. **Load is the mechanism behind every intermittent result in this suite**, and it is now measured rather than suspected: contention took kernel-boot stalls from 0 in 360 to 3 in 540 (constraint 155). `--negative kernel-stall` is the most load-sensitive control (2 ms busy-wait per syscall across 16 processes); it went red twice in 13 runs, both inside a back-to-back sweep, and 11 times clean when spaced. Treat a single red as unmeasured and re-run it alone |
| `node bench/m5-sh/probe.mjs` | M5's host gate, no browser: 111 checks over the shell's pure front end and the programs' pure parts |
| `python3 bench/m5-exec/controls.py` | 5 mutations of the exec loader, each scored on WHICH labels move. Two are narrow (the execute bit, the network refusal); one proves the import allowlist is what refuses an off-origin specifier; and two are a PAIR — collapsing the image cache key must move NOTHING, collapsing it *and* removing the byte comparison must move 17 |
| `scripts/fsfuzz.py` | host-side fs gate, no browser: 129 host tests, 10k torn journals, 42 failure-path assertions + a control, purity and lock lints |
| `scripts/check_links.py` | every path reference in the authored docs resolves |

**Run all of them before and after anything you change.** `scripts/check.py --controls` lists what
each control proves.

## The m4b flake: root-caused, and the one real defect it exposed

**It was exposure, not a defect in what m4b tests** — and it did expose one defect of our own.

`scripts/check.py --only m4b` reported BROKEN about 1 run in 12 on a page-level
`timed out waiting for spawned`. m4b is the only check that boots one kernel per proof — thirteen
per run, where every other check boots one.

`bench/kernel-churn/probe.py` boots N kernels and does nothing else: no pty, no pipes, no signals,
one trivial process each. It reproduces the identical stall, at the identical step:

| condition | boots | stalls | per boot |
|---|---|---|---|
| idle | 360 | 0 | 0% |
| three probes contending | 540 | 3 (`spawned` ×2, `up` ×1) | **0.56%** |

At 0.56% per boot a thirteen-kernel page fails ≈1 run in 14. m4b was failing at 1 in 12. That
arithmetic closing is why this explanation is believed and the five below were not.

**The defect:** `programImage` awaited `fetch` with no timeout, and the caller cannot be answered
until that load resolves — so a stalled program fetch made `spawn` HANG rather than fail, with no
errno and nothing in the trace. **M5 narrowed what this covers and the bound still holds:** `SYS_spawn` no longer fetches at all — `src/kernel/exec.mjs` reads a program through the mount table (constraint 123) — so a process cannot hang this way, and what `programImage` still serves is the page's own `t: "spawn"`, the supervisor path every bench page boots through and where the stall was measured. Now bounded at 5 s through `AbortController` and retried once
(constraint 155, `docs/DECISIONS.md` D21). Demonstrated both ways with
`bench/kernel-churn/probe.py --stall`, which serves headers and never a body: with the deadline the
kernel refuses by name, and with it raised the kernel hangs.

**Not ours:** the `up` stall is Chrome's worker startup under load. It fails closed — the harness
reports a run it could not measure, never a pass — so treat a lone BROKEN here as unmeasured and
re-run it alone.

**Verified with the bounded fetch:** the whole suite — boot 30, syscall 31, m1 14, m2 92, m3 55,
m4 23, m4b 54 = **299 expectations, all passing** — plus `check_links` over 208 references and the
fetch deadline demonstrated in both directions.

**"Load" means MEMORY, and this machine was the proof.** While the contention measurement above
was taken, `sysctl vm.swapusage` read 10.6 GB of 11.3 GB used with 64 MB of free RAM — the
developer's own Chrome, Firefox and an Ava agent, not the harness. Under that pressure `--only m1`
was killed outright mid-run, with the shell's own `echo exit=$?` never reaching the log, while a
stray `--only m2` of the same session was still competing with it. Read `vm.swapusage` before
believing any intermittent result, do not run two phases at once, and check that an earlier run of
your own is not still alive. The 0.56%-per-boot figure above was measured under that pressure and
is an upper bound, not a clean-machine number.

**A SLOW CHECK IS NOT A DEAD ONE,** and this was got wrong here first: m2 was written up as "never
finishes" on the strength of an empty unbuffered log and a `pgrep` that read zero, and it then
completed in **105.55 s** with all 92 expectations passing. Give it two minutes before concluding
anything. Waiting long enough is part of measuring.

Ruled out by measurement first, recorded so nobody repeats them: the proof count (11 vs 13,
unchanged), orphaned process workers (added a kernel `shutdown` sweep — right on its own terms,
changed nothing), the spin stage's CPU burn (1.5 s vs 10 s, unchanged), the server's threading
(already `ThreadingHTTPServer`), the listen backlog (1 vs 5 vs 128 unchanged, and zero
listen-queue overflows in `netstat -s -p tcp`), and truncated modules from the byte-range server
(`bench/kernel-churn/rangetest.py` — eight range forms byte-exact, four malformed forms refused).

## What M5 changed that touches everything after it

**`SYS_spawn` NO LONGER FETCHES.** A program path is resolved through the mount table and the bytes
come from the mount (`src/kernel/exec.mjs`). Three consequences a later milestone will meet:

- **A program's only linkable import is an absolute specifier** — `/src/abi.mjs`, never
  `"../x.mjs"`. A Blob image has no base for a relative one. The loader refuses such a program with
  -ENOEXEC and a note naming the specifier, because the alternative was measured: every stage of
  M4's pipelines faulted with SIGABRT and `/proc` said `never issued a syscall`, with nothing
  anywhere naming a specifier. Constraint 125.
- **Everything a process spawns must be IN a mount.** `/bench` is mounted under `bench: 1` only, so
  M4's and M4b's orchestrators keep spawning their stages by the same path strings. A new bench
  program that spawns anything needs a row in `BENCH_ENTRIES`.
- **The page's own `t: "spawn"` still takes a URL** and still fetches. That is deliberate — the
  page is the supervisor — and it is why only the process-side half moved. D18.

**Two libos stubs existed with no caller and were wrong-shaped until one arrived.** `sigaction`
had had none since M1; a shell without it DIES on the Ctrl-C it exists to forward. `nanosleep` had
every caller open-coding `packI64` and one of them passed (0, 0) — a zero-length sleep. Constraint
100's rule keeps earning its place.

**THE ONE THING M5 LEFT OPEN, and it is M6's.** A program's static imports are an ALLOWLIST of
exact literals now (`PROGRAM_IMPORTS`), because a pattern leaked: `new URL("//host/x.mjs", base)`
resolves OFF-ORIGIN, so a program could have the CHILD's module loader fetch and evaluate remote
code while the kernel's own accounting stayed at zero loads (constraint 139). A DYNAMIC
`import(expr)` with a computed argument cannot be caught by reading the text and no scanner can.
Deleting `fetch` does not close it either — `import` is the module loader. **A
Content-Security-Policy on the document is the answer**, and it belongs with constraint 41's realm
stripping in M6.

**A process worker's error is now that PROCESS's fault, not a kernel panic** (constraint 140). If
you add a second caller of `EXEC.load`, note that `linkProgram` can still throw for a specifier
`new URL` refuses; `spawnChild` wraps it, and an unwrapped caller would be a kernel panic on a
four-byte program.

**One signal costs two `-EINTR`s** (constraint 131). Any call made immediately after a signal may
answer -EINTR, and a program that cares must retry once. The kernel was NOT changed to deliver
once, and D20 records why and what a milestone that changes it owes.

## What M4a built, and the four things it leaves you

`MILESTONES.md` §M4a has the record and the measurements. The shape, because it is the thing a
later milestone will reason about:

```
  window.mjs + terminal.mjs   (page, DOM)        draws; never echoes; never syscalls
        |  postMessage on the KERNEL's own port
  /dev/console  = F_WIN        (kernel)          a queue in, a post out, a row in pollOne
        |  open/read/write/poll/close — NO NEW SYSCALL
  term.mjs                     (a PROCESS)       polls the console AND the pty master
        |  write(master)
  pty + line discipline        (kernel)          echo, ICANON, Ctrl-C  ← the character comes
        |  read(slave)                              back from HERE, not from the widget
  /usr/bin/sh                  (a PROCESS)
```

- **THE WINDOW IS A FILE DESCRIPTION, and that part is not the special case.** Keep it. A `winid`
  that is not an fd needs a busy-poll loop to be serviced alongside a pty, which is
  `docs/designs/REVIEW-FINDINGS.md` finding 1 and constraint 42. What M7 replaces is the one
  PRODUCER of the description — `open("/dev/console")` becomes `win_create` — and the ops row in
  `src/kernel/files.mjs` plus the row in `pollOne` survive unchanged. `src/kernel/console.mjs`'s
  header is where the special case is declared; delete the file, not the kind.
- **`src/wm/terminal.mjs` DOES NOT ECHO, and the whole milestone rests on that.** A widget that
  echoed locally would pass M4a's proof with no pty behind it. `--negative pty-detach` is the only
  thing in the suite that can tell the two apart, which is why it cuts at `Pty.writeInput` —
  accepting the bytes and discarding them — rather than anywhere closer to the window. If you add
  rendering, re-run that control and check it still takes six labels and not twenty.
- **A keystroke is readiness with no reply behind it.** `pollWake` is hooked on `reply`
  (constraint 109) and a keystroke arrives by `postMessage`, so `Console.feed` calls
  `pollWakeAll()` itself. Any future host-driven event source owes the same call. One spelling,
  because a second copy is a second place `--negative no-poll-wake` gets forgotten.
- **ENTER IS BYTE 10.** The discipline commits a line on LF and implements no `ICRNL`. A terminal
  sending CR types a line the shell never receives and the symptom is a prompt that accepts typing
  and never answers. Constraint 162.

Two found defects worth knowing about: the CR one above, and `bench/m3-provider/probe.mjs`'s
`implied directories exist` had been RED since M5 (a literal list against a manifest that grew
eleven rows). **The host probes are NOT in `scripts/check.py`'s registry and are run by hand, so a
red one can sit there for a whole milestone.** Run all of them, every time.

### Known duplication, not yet paid off

`kernelBoot` is copied into each of the eight `www/m*.html` pages. `www/m4a.html` makes nine. It
was left copied rather than extracted because every page is a shipped milestone whose bytes
`served_matches_disk` asserts, and a half-done extraction is worse than a whole duplication. The
next page is the ninth copy; extract it then, and re-run every check.

## Next: M6 — neuter the process realm

`MILESTONES.md` §M6 is the spec and constraint 41 is the list. **The one thing M5 left open is
M6's and it is the hard half:** a program's static imports are an allowlist of exact literals now,
but a DYNAMIC `import(expr)` with a computed argument cannot be caught by reading the text, and
deleting `fetch` does not close it because `import` IS the module loader. A
Content-Security-Policy on the document is the answer (constraint 139).

M4a adds one thing to M6's list that was not there before: **`src/wm/` runs in the PAGE, not in a
process**, so the realm stripping does not touch it — but `www/m4a.html` holds the kernel's own
message port, and a CSP that forbids what the page needs would break the one supervisor every
bench boots through. Check the page before the policy.

### What M4 and M4b leave you

Six host probes run without a browser and are the fast loop: `probe.mjs` under `bench/m3-synth`,
`m3-provider`, `m3-trace`, `m3-tmpfs`, `m4-pipe` and `m4b-pty`, plus `bench/m4-intr/probe.py`.

`bench/m4-fs/program.mjs` and `bench/m4b-fs/program.mjs` are the orchestrators — one mode per
proof, each spawning its own stages. Add a mode rather than a new program.

**`pipe2` and `pty_open` can return fd 0** (constraint 94), because `spawn` leaves fd 0 free and
`fds.add` hands out the lowest. Both orchestrators call `ensureStdin` first, and M5's shell does — it `fstat`s fd 0 and opens
`/dev/zero` only when it has to, so a shell started on a terminal pays one syscall.

**A blocking call parks on SEQ, never inside a synchronous call** (constraint 88, measured). An ops
row returns `null` to mean parked; `null` must be tested before any numeric use, because `null >= 0`
is true and a parked read that fell through answered the caller 0 — which on a pipe means EOF (96).

**A test double must not be gentler than the real thing.** M4's pipe probe gave the kernel a fake
`raise` that did not reap, and 68 assertions passed over a double-reply defect (98).

**A timeout must carry state.** A stopped pipe or pty raises no error — a parked reader is a
legitimate state — so the pages attach the kernel's park and refcount dump to their own timeouts.
That is what located constraints 92 and 103, each in one run.

### Treat any mechanism with no live caller as unverified

`ppid` was assigned nowhere, so `waitpid`, `parkParent` and teardown's parent-wake were all
unreachable — and two of them were wrong the moment they became reachable (90, 91). Teardown's fd
refcount was wrong for every dup'd description and had no symptom until a pty slave sat on two fds
(103). However finished a path looks, if nothing calls it, nothing has checked it.

## The method that worked

1. **Separate building from verifying, always.** Never let the agent that built something assess
   it. Every milestone went build → independent attack → fix → re-attack. The attackers found
   things the builders were certain were fine.
2. **Give the verifier the artifact and the acceptance criteria, never your conclusion.** An agent
   handed a hypothesis returns it confirmed.
3. **Demand measured before/after output pasted in.** "Fixed" without a reproduction that moved is
   not a result. Several agents reported fixes whose repro had silently failed to apply.
4. **Mutation-test the checks.** Break the kernel deliberately and confirm the suite notices. Four
   of seven mutations survived M2's first verification; each named a claim the suite could not
   defend.
5. **Tell the verifier not to round its verdict up**, and that its findings go verbatim into a
   normative document. It changes what you get back.

## Hard-won lessons, not obvious from the docs

- **A control must be scored on *which* expectations move**, not on pass/fail. A control satisfied
  by any failure never verifies its own subject. M1's and M2's controls both passed while proving
  nothing until this was enforced.
- **A fix that cannot be switched off has not been shown to be the fix.** Every negative control
  here is a runtime flag (`--io-inline`, `--no-crc`, `--no-sigpend`, `--no-cow-order`).
- **When an exhaustive search of the obvious shape keeps finding new instances, the shape is
  wrong.** M2 took five correct-but-insufficient fixes before the diagnosis was "every `await` is
  a yield point and nothing serializes per inode". Watch for that pattern and go up a level.
- **An errno collapsed into a benign value is this codebase's recurring bug.** It appeared three
  times (`IO_LIST` → `[]`, `IO_READ_ALL` → absent, `later()` dropping its rejection). Grep for
  places an error becomes a default.
- **`src/fs/` must stay pure** — no OPFS, SAB, Worker, async. `fsfuzz.py` lints it, and that
  purity is what makes 10,000 torn journals cost 3 seconds. A codec reaching for storage breaks
  the gate; that is the intended alarm.
- **The per-inode lock has ten declared takers and a lint enforcing them** (`fsfuzz.py`). A future
  multi-inode operation (`rename`) must acquire in ascending inode order.
- **Constraints 61–71 are recorded M2 limitations and 77–85 are M3's**, sorted into defect /
  permitted-by-decision / structural. Read them before "fixing" something that is a recorded
  decision.
- **A comment asserting an invariant is not evidence that the invariant holds.** The two worst
  findings in M3's review were exactly that — one claimed a state was unreachable when three
  syscalls reached it, another called a guard redundant when deleting it would have faulted the
  kernel. The critic read the code and was right both times.
- **Guard every table lookup with `hasOwnProperty`.** `FILES[name]` on an object literal resolves
  `constructor` and `toString`; that was a kernel fault reachable in two syscalls.
- **A control must move a NAMED subset of labels.** M3's first control spun a poll loop hard enough
  to lap the trace ring, so it also failed a proof it was not about; the poll was paced rather than
  the control re-scoped.

## Operational traps

- **Subagents die on infrastructure.** Six were lost to AWS 403 / 503 / ENOTFOUND, several after
  an hour of work. Check what landed on disk before re-running, and be ready to finish inline —
  the main session's calls were reliable when subagents were not.
- **Kill stray Chrome between runs:** `pgrep -f "showup-chrome-" | wc -l`, then
  `pkill -f "showup-chrome-"`. Leftovers compete for the renderer and corrupt latency numbers. One
  earlier run accumulated 136.
- **Never run two browser-driving things at once.** Doing so produced "Chrome could not be driven:
  connection closed mid-frame" — the harness correctly refused to report, but the measurement was
  mine contaminating my own.
- **This worktree's shell rejects complex git commands** and anything with a runtime-computed
  command name. Split them, or call Python.
- **Serve from the repository root, not `./www`** — `serve.py` defaults correctly; `www/m*.html`
  import `/src/...`.
- **M2's attack corpus is committed** at `bench/m2-attack/` — 194 scripts, copied out of the
  job-scoped directory before it expired. Evidence, not a gate: written against the tree as it
  stood during M2, and several have anchors that have since moved. The mutation harnesses patch
  `src/` in place and restore on exit, so check `git status` before trusting a result from one.

## Working rules

Commit per milestone with its measurements in the message. Checkpoint before moving on. Update
`MILESTONES.md`, `docs/CONSTRAINTS.md` and `docs/DECISIONS.md` as part of the milestone, not after
— a measurement that only exists in a commit message is not citable. Every figure names the
harness that produced it. Finish a milestone's proof *and* its negative control before starting
the next.

## Two judgement calls for whoever picks this up

- **M2 ran to eight verification rounds.** That was right for a filesystem holding user data and
  would be disproportionate for `/proc`. Scale the adversarial effort to what the milestone can
  lose.
- **`--prove-failure` is the suite's own self-proof.** If it ever times out, treat that as the gate
  reporting itself broken, not as flakiness to retry past. It did exactly that once, and the cause
  was real.
