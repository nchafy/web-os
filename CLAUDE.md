# CLAUDE.md

Guidance for working in this repository. My global rules in `~/.claude/rules/` still apply —
this file adds only what is specific to web-os, and does not restate them.

## What this is

A browser-hosted operating system: Windows 7 surface, Linux-shaped runtime. Processes with pids,
a syscall ABI, a POSIX-ish VFS, a real shell.

**The one invariant.** A process reaches the system only through the syscall channel. Not by
convention — by construction. The predecessor (`../webxp`) failed because apps were ES modules
that imported the filesystem directly and each app *was* its window, so nothing was isolated,
killable or backgroundable. Every change here is measured against whether it preserves the
boundary.

## Onboarding

Read in this order. The whole set is about 90 minutes; the first four are about 25 and are enough
to start work.

| # | File | Read it for | Size |
| --- | --- | --- | --- |
| 1 | `CONTEXT.md` | What a kernel, process and syscall *are*; why a browser makes this hard; what the other web OSes do; what the predecessor got wrong. **Start here even if you know Unix** — §2 and §4 are project-specific. | 5 min |
| 2 | `docs/CONSTRAINTS.md` | 51 numbered constraints. **Normative.** Cite by number in code comments and commit messages. | 10 min |
| 3 | `docs/ABI.md` | The 68-call syscall table, the SAB layout, errno space, fd inheritance, and the five decisions that carry the design. | 7 min |
| 4 | `MILESTONES.md` | What is done, what is next, the proof and negative control each milestone owes. | 5 min |
| 5 | `docs/DECISIONS.md` | 16 decisions, what each rejected, and whether it rests on a measurement or a judgement. **Read before arguing with any of them.** | 12 min |
| 6 | `PLAN.md` | Why the order is the order; options A/B/C; §9 what critics changed; §10 what is still unknown. | 15 min |
| 7 | `docs/designs/REVIEW-FINDINGS.md` | 24 verified critiques. Several are traps already walked into once. | 15 min |
| 8 | `docs/GLOSSARY.md` | Lookup, not prose. Use it as you go. | — |

Then as needed: `docs/research/gap-04.md` for the measurements everything is sized from,
`docs/research/gap-03.md` for how the ABI was derived, `docs/research/gap-07-fork.md` for why
`fork` is unavailable and why the first answer to that question was wrong, `docs/designs/*.md` for the four long-form
candidate architectures, `docs/research/01-07` for the reference-system teardowns.

### You are oriented when you can answer these without looking

1. Why must the kernel be a dedicated Worker rather than the main thread? (Two reasons: one is a
   thrown exception, one is a measured latency.)
2. What does a process actually hold, and why nothing else?
3. Why is there no `fork`, and what exactly does a shell lose?
4. What makes per-app-origin isolation and a blocking syscall channel mutually exclusive?
5. What does M6 close, and why is calling it "security" wrong?
6. Why is the OPFS blob directory flat and named by inode?
7. Why can't an Aero glass check use a flat backdrop?
8. M0 was the one milestone that could invalidate the whole plan. What did it measure, what did it
   accept on, and what did it change about the plan? (Three things it changed are in
   `MILESTONES.md` §M0; one of them makes the process table's cap advisory.)

If any answer is not available to you, the file that carries it is in the table above. If an answer
in the repo seems wrong, see §When a constraint looks wrong — do not route around it.

### What is where

```
CONTEXT.md        background: OS concepts, browser limits, the other web OSes, webxp
PLAN.md           the three options, the schedule, what critics changed, open gaps
MILESTONES.md     tracker: status, proofs, negative controls, open experiments
CLAUDE.md         this file: working rules for the codebase
README.md         orientation and the one-command start
docs/
  CONSTRAINTS.md  50 normative constraints  ← cite these
  ABI.md          the syscall table
  DECISIONS.md    decision log with evidence class per decision
  GLOSSARY.md     terms
  designs/        4 candidate architectures + REVIEW-FINDINGS.md
  research/       374 cited claims. Raw evidence, append-only.
scripts/
  serve.py        COOP/COEP static server. --no-isolation to prove a check fails.
  cdp.py          Chrome DevTools Protocol driver, carried from webxp
  check.py        the harness: one registry, --prove-failure, the negative controls
  check_floors.json  committed min_expectations ratchet. Lowering a floor is a reviewable diff.
bench/
  coep-tiles/     worked example of the harness discipline, with a working negative control
  syscall-contention/  M0's bench: the saturation sweep and its eight controls
src/
  abi.mjs         every integer both sides agree on, and nothing else   ← see below
  kernel/         the only privileged code
  libos/          in-process syscall stubs + realm lockdown — the trust boundary
  wm/             userland window manager                (empty until M7)
www/
  index.html      boot preflight: refuses to proceed if a capability is missing
  m0.html         the syscall-channel bench page
```

**`src/abi.mjs` sits outside the three-directory layout deliberately.** A syscall number, errno or
SAB offset must have exactly one definition imported on both sides, and the kernel and a process
are precisely the two sides — so the file can belong to neither. It holds integers and pure codecs,
performs no I/O and closes over no capability, which is why a process may import it. Do not move it
under `kernel/` (a process must not import kernel code) and do not give it behaviour.

The predecessor is a sibling checkout at `../webxp`, and also
<https://github.com/nchafy/webxp>. Several milestones port code from it. **If `../webxp` is not
present**, clone it beside this repo — the paths in `MILESTONES.md` assume it. Nothing in this
repo *depends* on it at runtime.

`docs/research/` is **append-only**: it records what was found when. If a finding turns out wrong,
correct `docs/CONSTRAINTS.md` and note the correction there; do not quietly edit the research to
match. `docs/DECISIONS.md` §Corrections already carries two such cases.

## Architecture rules

These are the ones a plausible-looking change breaks. Each has a constraint number.

- **The kernel is a dedicated Worker. Never the main thread.** `Atomics.wait` throws in a window
  agent, and a main-thread kernel inherits every long main-thread task as syscall latency —
  measured, 52 of 20,000 calls past 10 ms. (1, 3)
- **A process holds only integers.** No fd, OPFS handle, pipe buffer, window handle or lock lives
  in a process worker. `terminate()` offers no chance to finish, so anything releasable is
  kernel-side. (15)
- **The shell is a userland client of the same ABI.** Explorer, the taskbar and the window manager
  use the same syscalls as a third-party app. If the shell needs a privilege it cannot express as
  a capability it was granted, the boundary is fiction. (3 in `PLAN.md` §4)
- **No `fork`.** `spawn` + `pipe` + `setpgid` only. (20)
- **Processes get fds, never paths.** Resolve a path to an inode once, in the kernel, and cache.
  `getDirectoryHandle` is 85 µs per component. (24)
- **`open()` is rare, fd I/O is common.** `createSyncAccessHandle` is 495 µs — 100× a syscall. (22)
- **`fsync` is a separate call from `write`.** (23)
- **Signals arrive through the SAB control word**, checked at syscall entry. A process parked in
  `Atomics.wait` cannot service `postMessage`. (16)
- **Blocking parks with a finite re-arm interval and checks a kernel heartbeat.** Never an
  unbounded wait, and never fault a process on timeout alone. (46)
- **Teardown is not reap.** At `terminate()`: close fds, destroy windows, drop the taskbar button.
  The ~2 s quarantine protects the pid and the SAB, never the pixels. (14)
- **Signals, broadcasts and sweeps are O(interested), never O(N).** Round-tripping every live
  worker costs 378 µs each. (18)
- **The process table has a hard cap.** The renderer dies between 3,200 and 4,800 workers and
  every process shares it. (17)

## Deliberate decisions that look like bugs

Do not "fix" these. Each is load-bearing and each has a reason recorded.

- **The OPFS blob directory is flat, named by inode.** Not a workaround — it is how a real
  filesystem works, and it is what makes rename O(1) and hard links expressible. (26)
- **Writes are buffered; only `fsync`, snapshot and idle flush.** `flush()` is 260 µs against a
  5 µs write. This is POSIX's own contract. (23)
- **A bad superblock mounts read-only and reports.** It never reseeds. webxp reseeds; that is the
  defect being fixed, and it is silent data loss presented as success. (28)
- **A credential is an argument on every path call, not instance state.** Otherwise every process
  shares one identity and the mode bits are decoration. (29)
- **Window surfaces are transferred `OffscreenCanvas`**, which is why the window ABI is `win_*`
  calls and not a `/dev/wm` device file — a file write cannot transfer a handle. (`PLAN.md` §5)

## Code conventions

- **No dependencies, no build step, no framework.** ES modules served as files, as in the
  predecessor. A dependency must be justified where it is introduced, and vendored with its
  licence beside it.
- **`.mjs` for modules, `.py` for tooling.** Python is stdlib-only except `websocket-client` for
  CDP, in a `.venv`.
- Layout: `src/kernel/` (the only privileged code), `src/libos/` (the in-process syscall stubs and
  the realm lockdown), `src/wm/` (userland), `scripts/` (tooling), `bench/` (harnesses that
  produce numbers), `www/` (what the browser loads).
- **`src/libos/` is the trust boundary in file form.** Anything added there runs inside a process,
  so review it as untrusted-adjacent: it must not acquire a capability the kernel did not hand it.
- A syscall number, errno or SAB offset is a named constant in one place, imported on both sides.
  Two copies hand-synced across the kernel/process boundary is the defect this rule exists for.

## Verification

The harness is the point. `../webxp/scripts/check.py` is 82 checks in 11,991 lines, and 59 of them
are not geometry assertions — `check_boot`, `check_mount`, `check_filesystem`,
`check_fs_persistence`, `check_terminal`, `check_routes` port into this project's spine.

- **Every check needs a negative control** that breaks the thing the check is about. Breaking
  something adjacent proves nothing.
- **Preserve `--prove-failure`**: it inverts every registered check's expectations so the run must
  report failures. A harness nobody has seen fail is a harness nobody has checked. Inversion is a
  **per-check declaration, not a maintained tuple** — a list kept beside the checks drifts from
  them, so `Control.INVERT` is mandatory and the opt-out needs a reason string that `audit()` reads.
  It exits 0 when the proof *succeeded*; non-zero is reserved for a proof that failed.
- **Inversion alone does not prove a check is coupled to its subject**, because an assertion over a
  constant still inverts and still fires. Only a negative control closes that, which is why every
  check must declare one that is re-runnable and scored.
- **A check whose measurement does not exist without a capability must declare that**, with a
  reason. Then the no-isolation control is satisfied by the measurement going away — which is what
  lets a kernel check, whose SAB is not constructible without COOP/COEP, be registered at all. An
  *undeclared* unmeasurable check is a stray and fails the gate.
- **A window manager cannot be checked by screenshot.** An inert frame and a working one are the
  same picture. Drive real input, read the geometry back.
- **Glass cannot be checked against a flat backdrop.** `blur(flat) == flat`, so the assertion
  passes with the blur switched off. Sample across a high-contrast seam and assert the gradient.
  (50)
- **A threshold on a continuous input gets hysteresis, and both edges get checked.**
- `bench/` harnesses must assert `crossOriginIsolated === true` and **abort** rather than report a
  number from a non-isolated context. `scripts/serve.py --no-isolation` exists to prove they do.

## Running it

```sh
scripts/serve.py                    # serves ./www with COOP/COEP on 8000
scripts/serve.py --no-isolation     # omit the headers, to prove a check fails without them
scripts/check.py                    # the suite
scripts/check.py --prove-failure    # invert every expectation; the run MUST report failures
scripts/check.py --controls         # what negative controls exist and what each proves
python3 bench/coep-tiles/probe.py   # the worked example: a real harness with a negative control
```

**`www/m0.html` needs the repository root, not `./www`**, because it imports `/src/abi.mjs` and
`/bench/...`. Use `scripts/serve.py --root . --port 8000` and open `/www/m0.html`, or just run
`bench/syscall-contention/probe.py`, which binds its own server on the right root. The page carries
a module-graph preflight, so serving it from the wrong root says which imports 404'd rather than
rendering a blank screen.

`python3 -m http.server` **will not work** — it cannot send COOP/COEP, so `SharedArrayBuffer` is
undefined and nothing boots. `www/index.html` is a preflight that refuses to proceed and says why.

## When a constraint looks wrong

Measure it. Do not reason it away, and do not assume the number in `docs/CONSTRAINTS.md` is stale
because it is inconvenient.

Every figure there names the harness that produced it, on Chrome 157 / macOS 26.7.2 / Apple M2
Pro / 120 Hz / dpr 2. If your machine differs, say so beside the new number rather than replacing
the old one. If a constraint is genuinely falsified, update it, cite the evidence, and note the
correction — `docs/CONSTRAINTS.md` already carries one 4× arithmetic error that was caught and
fixed that way, and the record of it is more useful than a clean file.

## Scope

Milestone order is risk order: the riskiest assumption is tested first, which is why M0 is one day
and comes before anything else. Do not reorder to get something visible sooner — M4a already
exists for that reason.

Finish a milestone's proof and its negative control before starting the next. A milestone without
a failing-capable check is not done, however much of it is written.

## Path conventions in the docs

Three kinds of path appear, and telling them apart matters because two of them do not exist in
this repository.

- **`docs/…`, `scripts/…`, `src/…`, `bench/…`, `www/…` in `CLAUDE.md`, `README.md`, `CONTEXT.md`,
  `PLAN.md`, `MILESTONES.md`, `docs/CONSTRAINTS.md`, `docs/ABI.md`, `docs/DECISIONS.md`** — paths
  in *this* repo, written **relative to the repository root** wherever they appear. Some are
  forward references to files a milestone has not created yet;
  `scripts/check.py` is the main one, and `MILESTONES.md` records it as owed.
- **`../webxp/…`** — the predecessor, a sibling checkout, also
  <https://github.com/nchafy/webxp>. Always written with the prefix in the authored docs.
- **Bare `src/…` or `scripts/…` inside `docs/designs/` and `docs/research/`** — these are
  generated artifacts kept verbatim as evidence, and a bare path in them usually means either a
  webxp file or a file that design proposed and which was never built. **Do not go looking for
  them here.** Resolve against the surrounding text, and prefer the authored docs above as the
  statement of what exists.
