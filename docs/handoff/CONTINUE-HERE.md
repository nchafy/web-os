# web-os: continue implementation

Written 2026-11-15 by the session that built the harness through M2, and updated the same day by
the session that built M3, M4 and M4b. This file carries only what the repository cannot
tell you. Everything the repo settles, the repo settles.

## Where the work is

- **Worktree:** `/Users/chafyni/claude/web-os/.claude/worktrees/webos-impl` — work here, not in
  the parent checkout.
- **Branch:** `worktree-webos-impl`, pushed to `origin`. `main` is still at the scaffold `c3d826f`
  and fast-forwards cleanly. Git refuses to move `main` from inside a worktree,
  so if the user wants it merged:
  `cd /Users/chafyni/claude/web-os && git merge --ff-only worktree-webos-impl`
- **Python:** `.venv/bin/python` (3.8, has `websocket-client`). **Node:** 18.20.2 on PATH.
  **Chrome:** 157.0.8103.52 — `docs/CONSTRAINTS.md`'s older figures were taken on 157.0.8103.38,
  so name the build beside any new number.

## Read these first, in this order

`CLAUDE.md` has an onboarding table — follow it. Short version: `CONTEXT.md`, then
`docs/CONSTRAINTS.md` (120 numbered constraints, **normative**, cite by number), `docs/ABI.md`,
`MILESTONES.md`. Then `docs/DECISIONS.md` before arguing with any decision.

Do not re-derive anything those files settle. They are the product of adversarial review, and
several record a specific mistake and its correction.

## Done

Harness, M0, M0a, M0b, M1, M2a, M2, M3, M4, M4b and **M5**. Each has a record in `MILESTONES.md` with its actual cost
and what it changed in the plan. Current gates, all green:

| command | what it is |
|---|---|
| `scripts/check.py` | the suite — 8 checks, 336 expectations |
| `scripts/check.py --prove-failure both` | inverts every expectation, and runs the no-isolation phase; must report failures |
| `bench/m4b-pty/controls.py` | the pty's 5 mutation controls, each scored on WHICH labels move |
| `scripts/check.py --negative <control>` | 17 controls; `--controls` lists what each proves. **Kill stray Chrome AND WAIT FOR IT TO EXIT between runs** — `pkill` returns before Chrome is gone, and a control run that overlaps a dying one reports a false failure. Measured: `--negative kernel-stall` turned `no error or lost-reply path` red twice in 13 runs, both times back-to-back inside a sweep, and 11 times clean when the runs were spaced. The control busy-waits 2 ms per syscall across 16 processes, so it is the most load-sensitive thing in the suite. Not caused by any code change — treat a single red here as unmeasured and re-run it alone |
| `node bench/m5-sh/probe.mjs` | M5's host gate, no browser: 111 checks over the shell's pure front end and the programs' pure parts |
| `python3 bench/m5-exec/controls.py` | 5 mutations of the exec loader, each scored on WHICH labels move. Two are narrow (the execute bit, the network refusal); one proves the import allowlist is what refuses an off-origin specifier; and two are a PAIR — collapsing the image cache key must move NOTHING, collapsing it *and* removing the byte comparison must move 17 |
| `scripts/fsfuzz.py` | host-side fs gate, no browser: 129 host tests, 10k torn journals, 42 failure-path assertions + a control, purity and lock lints |
| `scripts/check_links.py` | every path reference in the authored docs resolves |

**Run all of them before and after anything you change.** `scripts/check.py --controls` lists what
each control proves.

## One open flake, measured and not root-caused

`scripts/check.py --only m4b` reports **BROKEN** about **1 run in 12**, with
`www/m4b.html reported state 'error': Error: timed out waiting for spawned`. The page boots a
fresh kernel per proof and one of them does not answer `spawned` inside its 20 s deadline.

What has been ruled out, each measured in a loop of 12 with Chrome killed and 1 s to exit between
runs:

| hypothesis | measurement |
|---|---|
| the thirteen proofs added in this round | 11/12 on the committed tree at **eleven** proofs too |
| orphaned process workers from `worker.terminate()` | 11/12 with the new `shutdown` sweep, 11/12 without |
| the `ttyspin` wall-clock ceiling burning CPU | 4/5 at 1500 ms, same rate as at 10000 ms |
| a single-threaded test server | `scripts/check.py` already uses `ThreadingHTTPServer` |

**It fails closed.** The harness reports a run it could not measure, never a pass — so a single
BROKEN here is not evidence of a defect in the code under test. Re-run it alone. If you pick this
up, the next thing to look at is `www/m4b.html`'s `kernelBoot`: the page never observes the
kernel's `up` for the stuck proof, so the question is whether `new Worker` is the thing stalling.

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

## Next: M4a — the terminal gets a real window

`MILESTONES.md` §M4a is the spec. The pty it points at exists and is verified, so this is the UI
half: drop in `../webxp/src/window.mjs` unstyled and point it at the pty.

Three things the docs already settle, so do not re-derive them:

- **That window is a special case with an expiry date.** `MILESTONES.md`: "This window is
  special-cased, not an ABI. M7 generalises it and deletes the special case. Say so in the code or
  it becomes the architecture by accident."
- **It cannot be checked by screenshot** (constraint 40). An inert frame and a working one are the
  same picture. The proof is "type into the window, assert the pty echoed it"; the control is
  "detach the pty, the keystroke must not appear."
- **`poll` is already there and M4a is the reason it exists.** `docs/designs/REVIEW-FINDINGS.md`
  finding 1's *corrected* scenario is the case this will hit: parked in `read(master)` at idle with
  no output, keys dead indefinitely. Use `poll` over the window fd and the pty rather than
  blocking on either.
- **The "not responding" detector lands here**, deliberately deferred from M1 — a kernel-side timer
  plus a UI hook, and there was no UI to hook until now.

Then M6, then option A (M7–M14). **M5 is done**, so M4a now has a real shell to point the pty
at: `spawn("/usr/bin/sh", ["sh"], actions)` with the slave on fds 0, 1 and 2, the shell in its own
group, and that group made the terminal's foreground — `bench/m5-sh/program.mjs`'s `p_tty` is a
working example of exactly that, including the Ctrl-C and Ctrl-D paths.

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
