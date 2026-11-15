# web-os: continue implementation

Written 2026-11-15 by the session that built the harness through M2, and updated the same day by
the session that built M3 and M4's pipe half. This file carries only what the repository cannot
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
`docs/CONSTRAINTS.md` (71 numbered constraints, **normative**, cite by number), `docs/ABI.md`,
`MILESTONES.md`. Then `docs/DECISIONS.md` before arguing with any decision.

Do not re-derive anything those files settle. They are the product of adversarial review, and
several record a specific mistake and its correction.

## Done

Harness, M0, M0a, M0b, M1, M2a, M2, **M3**, and **M4's pipe half** — the pty, the line discipline
and `poll` are M4b and are not done. Each has a record in `MILESTONES.md` with its actual cost and
what it changed in the plan. Current gates, all green:

| command | what it is |
|---|---|
| `scripts/check.py` | the suite — 6 checks, 243 expectations |
| `scripts/check.py --prove-failure` | inverts every expectation; must report failures |
| `scripts/check.py --negative <control>` | 12 controls; `--controls` lists what each proves. **Kill stray Chrome between runs** or a sweep reports a false BROKEN |
| `scripts/fsfuzz.py` | host-side fs gate, no browser: 91 host tests, 10k torn journals, 42 failure-path assertions + a control, purity and lock lints |
| `scripts/check_links.py` | every path reference in the authored docs resolves |

**Run all of them before and after anything you change.** `scripts/check.py --controls` lists what
each control proves.

## Next: M4b — the pty, the line discipline, and `poll`

M4's pipe half is done and verified; `MILESTONES.md` §M4 carries the record and §M4b is the rest.
**The owed experiment is retired** — a synchronous OPFS read cannot be interrupted, and `read()` is
INTR-capable anyway because the handles are in the I/O worker. Constraints 86–89,
`bench/m4-intr/probe.py`.

Two things to settle before writing code, both found by reading the docs against each other:

- **`poll` is required by constraint 42 and is absent from M4's build list.** The constraint is
  normative: `poll()` MUST be the single wait primitive over fds, because a process has one futex
  word and one outstanding call, so one window plus a pipe cannot otherwise wake it. The case that
  hits it first is `docs/designs/REVIEW-FINDINGS.md` finding 1's *corrected* scenario — parked in
  `read(master)` at idle with no output, keys dead indefinitely — which is M4a's terminal, not M7.
- **`ICANON` and `ECHO` semantics are specified nowhere** in any authored doc. Only `ISIG`/`VINTR`
  is: Ctrl-C raises SIGINT on the foreground group even when the UI is wedged. Treat the rest as
  POSIX-default by assumption and say so where you implement it. `docs/ABI.md` also requires `VMIN`
  and `VTIME` in the termios struct, which M4's flag list omits.

### What M4 leaves you

`bench/m4-pipe/probe.mjs` (68 assertions) and `bench/m4-intr/probe.py` run without a browser.
`bench/m4-fs/program.mjs` is the pipeline orchestrator: one mode per proof, spawning its own
stages. Add a mode rather than a new program.

**`pipe2` can return fd 0 as the read end** (constraint 94), because `spawn` leaves fd 0 free and
`fds.add` hands out the lowest. A process building a pipeline MUST open its own stdin first — the
orchestrator calls `ensureStdin` for exactly this. M5's shell has to do the same or inherit the bug.

**A blocking call parks on SEQ and never inside a synchronous call** (constraint 88, measured). An
ops row returns `null` to mean parked and `calls.mjs` turns that into PENDING; `null` must be
tested before any numeric use, because `null >= 0` is true and a parked read that fell through
answered the caller 0, which on a pipe means EOF (96).

### The four defects that had never run

`ppid` was assigned nowhere, so `waitpid`, `parkParent` and teardown's parent-wake were all
unreachable — and two of them were wrong the moment they became reachable (constraints 90, 91).
**Treat any mechanism with no live caller as unverified**, however finished it looks.

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
