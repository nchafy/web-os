# web-os: continue implementation

Written 2026-11-15 by the session that built the harness through M2. This file carries only what
the repository cannot tell you. Everything the repo settles, the repo settles.

## Where the work is

- **Worktree:** `/Users/chafyni/claude/web-os/.claude/worktrees/webos-impl` — work here, not in
  the parent checkout.
- **Branch:** `worktree-webos-impl`, head `048b0d7`. `main` is still at the scaffold `c3d826f`,
  24 commits behind, and fast-forwards cleanly. Git refuses to move `main` from inside a worktree,
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

Harness, M0, M0a, M0b, M1, M2a, M2. Each has a record in `MILESTONES.md` with its actual cost and
what it changed in the plan. Current gates, all green:

| command | what it is |
|---|---|
| `scripts/check.py` | the suite — 4 checks, 167 expectations |
| `scripts/check.py --prove-failure` | inverts every expectation; must report failures; 51–52 s |
| `scripts/check.py --negative <control>` | 6 controls: no-isolation, empty-root, patched-required, patched-optional, kernel-stall, no-sigpend |
| `scripts/fsfuzz.py` | host-side fs gate, no browser: 91 host tests, 10k torn journals, 42 failure-path assertions + a control, purity and lock lints |
| `scripts/check_links.py` | every path reference in the authored docs resolves |

**Run all of them before and after anything you change.** `scripts/check.py --controls` lists what
each control proves.

## Next: M3

`MILESTONES.md` §M3 is the spec and is authoritative. Then M4 (pipes/pty, with a prerequisite
experiment), M4a, M5, M6, then option A (M7–M14).

`MILESTONES.md` §"Open experiments" lists three cheap measurements owed before the milestones that
depend on them. The `Atomics.notify` vs synchronous-OPFS-read one is owed **before M4**, and
`docs/ABI.md` currently marks `read()` INTR-capable without having measured it.

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
- **Constraints 61–71 are recorded M2 limitations**, sorted into defect / permitted-by-decision /
  structural. Read them before "fixing" something that is a recorded decision.

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
- **`/Users/chafyni/.claude/jobs/e856c39e/tmp/` holds eight rounds of attack scripts**
  (`vattack*.py`, `run7.sh`, `judge7.py`, `sweep.sh`, `mutate.py`, `edge` controls). **Reuse
  them** — they are the regression corpus for the VFS, and re-running them is the cheapest check
  that a change did not reopen something. That directory is job-scoped and will not survive
  forever; copy anything worth keeping into `bench/`.

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
