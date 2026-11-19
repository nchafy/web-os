# web-os: continue implementation

Written 2026-11-15 by the session that built the harness through M2, and updated the same day by
the session that built M3, M4 and M4b. This file carries only what the repository cannot
tell you. Everything the repo settles, the repo settles.

## Where the work is

**M7 LANDED ON BRANCH `m7-window`, IN `.claude/worktrees/m7-window`, on top of the cleaned
history (`rewritten2` / `origin/webos-clean-history-v2`).** That is the tip: it contains the clean
history and M7. Branch from it, or merge it into whatever you are calling authoritative, BEFORE
writing anything on top — the constraint numbering alone makes a second fork expensive, and M7
appended 210–216.

**The note below is the older arrangement and is kept because its reasoning still applies.** THE
AUTHORITATIVE WORKTREE WAS `.claude/worktrees/webos-impl`, ON BRANCH `worktree-webos-impl`. It is the only branch that contains every commit in the
repository, and it is pushed.

- **Why this needed saying.** Six worktrees existed on five branches and development had forked in
  two places at once: M4a on `m4a-terminal-window` and an M5 fix on `worktree-webos-impl`, neither
  containing the other. Both had appended constraints numbered 155 and 156, because on each branch
  those numbers were free — so the merge was a reconciliation and not a textual one, and the
  incoming pair was renumbered 185 and 186. A second fork of that kind costs the same again.
- **Before starting work, check nothing has forked under you:**
  `git worktree list` then `git merge-base --is-ancestor <other-branch> HEAD` for each. An ancestor
  is contained and can be ignored; anything else has to be merged BEFORE more is written on top.
- **The other worktrees are redundant as of this commit** — `m4a-window`, `m4b-flake`,
  `learning-mode`, `hobbyist-os-research` and `m6-realm` are all ancestors of this branch, and
  `main` is still the scaffold `c3d826f`. They are kept rather than deleted because other sessions
  may hold uncommitted work in them. Confirm each is clean before removing it, and never with
  `--force`.
- **`main` is still at the scaffold.** Git refuses to move it from inside a worktree, so:
  `cd /Users/chafyni/claude/web-os && git merge --ff-only worktree-webos-impl`
- **If you are a parallel session**, branch from `worktree-webos-impl` and merge back into it
  often. Do not let two branches grow past one shared ancestor; the constraint numbering alone
  makes that expensive.
- **Python:** `.venv/bin/python` (3.8, has `websocket-client`). **Node:** 18.20.2 on PATH.
  **Chrome:** 157.0.8103.52 — `docs/CONSTRAINTS.md`'s older figures were taken on 157.0.8103.38,
  so name the build beside any new number.

## Read these first, in this order

`CLAUDE.md` has an onboarding table — follow it. Short version: `CONTEXT.md`, then
`docs/CONSTRAINTS.md` (205 numbered constraints, **normative**, cite by number), `docs/ABI.md`,
`MILESTONES.md`. Then `docs/DECISIONS.md` before arguing with any decision.

Do not re-derive anything those files settle. They are the product of adversarial review, and
several record a specific mistake and its correction.

## Done

Harness, M0, M0a, M0b, M1, M2a, M2, M3, M4, M4b, M5, M4a, M6 and **M7**. The spine is COMPLETE and
the window half has started; the next milestone is **M8, the window surface**. Each has a record
in `MILESTONES.md` with its actual cost and what it changed in the plan. Current gates, all green:

| command | what it is |
|---|---|
| `scripts/check.py` | the suite — 11 checks, 432 expectations. Measured 2026-11-19 on Chrome 157.0.8103.79: boot 30, syscall 31, m1 14, m2 92, m3 55, m4 23, m4b 54, m5 38, m4a 22, m7 42, m6 31 |
| `scripts/check.py --negative win-first-fd` | M7's first control — a parked `poll` evaluates only the FIRST fd of its set. 6 red, 36 intact, and the real keystroke into window A must still arrive |
| `scripts/check.py --negative no-cascade` | M7's second — destroying a parent destroys only the parent. 11 red, 31 intact, and every poll and `/proc` label must hold |
| `node bench/m7-win/probe.mjs` | 128 host checks over the window table and one window: the event queue and its bounded overflow, the parks, the record floor, the cascade across processes, the owner refusals, the cap, the detector's two edges |
| `bench/m7-win/controls.py` | 5 mutations of `wins.mjs`, scored on WHICH checks move. One is a DECLARED CRASH (`no-floor`), because a torn record must make a program fail loudly rather than decode as noise |
| `bench/m7-win/firefox.py` | M7 IN A SECOND ENGINE. Renders the page headless and keeps the PNG — these pages print their own log, and Mozilla removed CDP so there is no driver. A slow subresource injected into the served HTML holds the load event open until the proofs finish. Verdict ok in 18.8 s on Firefox 156 |
| `bench/m7-win/drive.py` | the fast loop: open `www/m7.html` in a real Chrome and print its own evidence, clause by clause. `--live` leaves the desktop open; `--page m4a` drives that one |
| `bench/kernel-churn/probe.py --drop` | the program fetch dropped at the TRANSPORT, which panicked the kernel before constraint 212. Every kernel must still boot AND one must report a transport retry |
| `scripts/check.py --negative pty-detach` | M4a's control — a write to the pty master discards its bytes. 6 red, 20 intact |
| `scripts/check.py --negative no-lockdown` | M6's first control — the process realm is not stripped, so a uid-1000 process writes the kernel's blob by inode. 14 red, 17 intact, and every LOADER clause must hold |
| `scripts/check.py --negative no-csp` | M6's second control — the process realm's policy is not served, so a computed `import(expr)` and `eval` work again. 8 red, 23 intact, and every REALM clause must hold |
| `node bench/m6-realm/probe.mjs` | 25 host checks over the lockdown, including the ONE path no browser can reach: its refusal to evaluate program text when a binding survives |
| `bench/m6-realm/controls.py` | 3 mutations of the lockdown, scored on WHICH checks move. `shallow` is the obvious mistake (own-property `delete` removes nothing here); `no-verify` is the dangerous one (a green report over an open realm) |
| `bench/m6-realm/csp-probe.py` | WHERE a policy has to be delivered, as a measurement: four deliveries, its own second origin for the off-origin row. `--no-isolation` proves it refuses to report |
| `node bench/m4a-window/probe.mjs` | 29 host checks over the window's clamp — the one part of `src/wm/` whose failure is invisible on screen |
| `node bench/m3-synth/probe.mjs` | 90 host checks over `/proc` and `/dev`. It was 98 with `/dev/console`'s thirteen; M7 deleted the device and the mechanism, and what replaced them is the simpler rule that EVERY generated file refuses a write |
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
  `src/kernel/files.mjs` plus the row in `pollOne` survive unchanged. **M7 did exactly that**:
  the device file is deleted, the kind is not, and `src/kernel/wins.mjs` is where the window lives
  now (constraint 211).
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

### THE SUITE DRIVES ONE ENGINE, AND THAT IS NOW A MEASURED GAP

`scripts/cdp.py` launches Chrome. Every figure in `docs/CONSTRAINTS.md` is a Chrome figure, which
the docs say — but the suite being green had been read as "it works", and M4a is where that bill
arrived: `setPointerCapture` on an untrusted pointerId throws in Firefox and does not in Chrome, so
the window was undraggable in one browser while 26 expectations passed in the other (constraint
175). A critic had raised the call and it was dismissed because the check was green.

Nothing here needs a cross-browser harness yet, and building one is not the next milestone's job.
What IS owed, cheaply:

- **Open the page in a second browser by hand after any `src/wm/` change.** It cost two reports to
  find this and about a minute to confirm each time.
- **Treat "the check is green" as evidence about the engine the check ran on.** Where a DOM call
  can refuse — pointer capture, clipboard, OPFS, `requestFullscreen` — assume one engine refuses it
  and write the code so the refusal is not load-bearing.
- M7 to M14 are the window half and will multiply this surface. A second engine in the harness is
  worth pricing THERE, not before.

### The page leaves a live terminal, deliberately

`www/m4a.html` ends by opening one session it does not tear down — that is what `MILESTONES.md` M4a
means by "something on screen before day 30", and it had stopped doing it: every proof terminated
its own kernel and left its frame, so the page finished showing dead windows that still accepted
keystrokes (constraint 179). A proof window is destroyed with its kernel now. If you add a proof,
destroy its window in the same `finally`.

### Known duplication, not yet paid off

`kernelBoot` is copied into each of the eight `www/m*.html` pages. `www/m4a.html` makes nine. It
was left copied rather than extracted because every page is a shipped milestone whose bytes
`served_matches_disk` asserts, and a half-done extraction is worse than a whole duplication. The
next page is the ninth copy; extract it then, and re-run every check.

## What M7 built, and the four things it leaves M8

**A window is a file description.** `win_create` (48) returns an fd in r0 and a winid in r1,
`win_destroy` (49) returns the LIST of winids it destroyed, `win_set` (50) changes a field. The
window's events are the fd's readable set, so `read(2)` and `poll(2)` are the only wait primitives
and there is no `win_poll`. `/dev/console`, the chardev mechanism under it and the ENXIO it answered
are deleted (constraint 211). `docs/ABI.md` §"The window group, as M7 built it" is the reference.

1. **THE SURFACE IS M8's AND NOTHING HERE PRE-EMPTS IT.** A window currently shows what a process
   `write`s to its fd, rendered by `src/wm/terminal.mjs` as text. `src/wm/winhost.mjs` builds that
   widget per window in ONE place (`#create`), so a surface replaces that line and nothing else —
   and `MILESTONES.md`'s ordering correction says to decide server-allocated versus transferred
   `OffscreenCanvas` BEFORE M12's governor, because the governor cannot account what it did not
   allocate.

2. **`WEV_CLOSE` IS DELIVERED AND NOT ENFORCED, which is M9's job.** The page's X button posts the
   event AND `win-gone`; the frame goes either way. `src/bin/term.mjs` says so where a reader meets
   it. Do not let a program pretend to refuse before M9 makes the refusal real.

3. **THE OWNER CHAIN ALREADY CROSSES PROCESSES, and that was deliberate.** `owner` may name a
   window in another process, `win_destroy` cascades across the boundary, and the other process
   learns on its own fd through the one `WEV_DESTROYED` record a destroyed window keeps. M9 adds
   `modal` — which is a different axis from owner, per the ordering correction: SerenityOS's
   enforced `WindowMode` describes BEHAVIOUR (`Modeless | Passive | RenderAbove | Blocking`) where
   `modal ∈ {none, window, app, system}` describes SCOPE, and an owned window needs both.

4. **THE EVENT RECORD IS FIXED WIDTH AND THE QUEUE IS BOUNDED PER FD.** 16 bytes, one codec in
   `src/abi.mjs`, reads floored to whole records and -EINVAL for a buffer that cannot hold one.
   `WIN_EVENT_CAP` = 256 records, the NEWEST dropped and counted, because the oldest is the one the
   not-responding detector is measuring (constraint 213). A pointer event stream will be the first
   thing to test that budget — add it as a type, not as a second queue.

**Two traps, both paid for once:**

- **A clause satisfiable by the system's own setup is not a proof.** The headline poller ran until
  every fd had woken it once, and the page's own geometry report had already made all three ready
  before a key was pressed (constraint 214). Ask what the system does on its own before writing an
  exit condition.
- **A `const` declared below `main()` is in its temporal dead zone when the page runs.** These
  pages call `main()` while the module is still evaluating, so a timeout constant declared beside
  the function that reads it threw `Cannot access 'BOOT_WAIT_MS' before initialization` on EVERY
  run — deterministic, and found in one run because the page reports its own reason. Declare page
  constants above the `main()` call, where the others are.
- **`scripts/check.py` is not the fast loop for a window milestone.** `bench/m7-win/drive.py`
  prints the page's clauses in two seconds of reading; the check prints a verdict. Both were
  needed, and the probe + `controls.py` caught three weak assertions the browser never would.

## What M6 changed that touches everything after it

**THE SPINE IS DONE.** M7 is next and `MILESTONES.md` §M7 plus `PLAN.md` §5 are the spec. Three
things M6 leaves behind that a later milestone will meet:

- **A PROGRAM RUNS IN A STRIPPED REALM NOW**, and a window milestone is the first thing likely to
  want something from it. `src/libos/lockdown.mjs` is the list, as data. If M7 needs a capability
  for a userland window manager, it arrives as a SYSCALL — adding a row back is reverting the
  milestone. `OffscreenCanvas` is transferred over the port and is unaffected; it is not a
  binding the strip touches.
- **`src/libos/` RESPONSES CARRY A CONTENT-SECURITY-POLICY** (`scripts/serve.py`,
  `PROCESS_REALM_PREFIX`). Anything new in that directory inherits it: no `fetch`, no `eval`,
  no `data:` import. **Do not add `worker-src` or `child-src` back** — Firefox applies them to
  the worker's own creation and no process starts at all (constraint 206). Nested workers are
  closed by the strip, not by the policy. A file that needs any of those does not belong in the process
  realm. The kernel's own worker is unaffected — `src/kernel/` carries no policy, deliberately,
  because the kernel fetches providers and mints the program images.
- **A program's `run` MAY BE ASYNC** and the libos awaits it (197). Every program in `src/bin/`
  stays synchronous; a syscall blocks in `Atomics.wait` and needs no await.

**M6 did NOT ship a document policy and that was a decision, not an omission** (D27, constraint
200). If a later milestone wants one for the page's own sake, it needs its own control, and
`www/m4a.html` — the supervisor every bench boots through — is what it has to not break.

**What M6 leaves open, and it is written down rather than implied** (constraint 199):
`script-src 'self'` means a program can still dynamically import ANY same-origin module. CSP
cannot express a path without an origin and the origin is a runtime port, so this is not
tightenable in the header. It is also why M6 is **hardening and not a security boundary** —
same-origin is not a security boundary, and the threat model for v1 is first-party only. Keep
saying that wherever M6 is described.

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

## What M6's review found, because it is the generalisable one

**A GUARD WRITTEN AGAINST A LIST OF SPELLINGS IS A GUARD AGAINST THAT LIST.** M6's policy decided
whether to bound a realm by testing the request path's prefix. It was hardened once — normalized,
seven spellings checked, committed with a message saying so — and the critic then served the same
file with no policy using an eighth: `GET /%2fsrc/libos/process.mjs`, 200, byte-identical, no
header, module loader unbounded. The fix was not a longer list. It was to ask the question of the
RESOLVED FILE, through the same `translate_path` that decides which bytes are sent, so the policy
follows the bytes and no spelling can disagree with it.

Two smaller ones worth carrying forward:

- **An untaken measurement is not a failed proof.** M6's `/proc` read can expire with the ~2.2 s
  terminate quarantine, which says nothing about whether the process faulted. It reports `expired`
  and the check raises UNMEASURABLE. A harness that scores correct kernel behaviour as a defect is
  worse than one that says it could not measure.
- **An `await` added to a message handler removes a serialization nobody wrote down.** The
  synchronous `run` held "one program at a time" by construction; the async one does not, so it is
  now a guard that faults on re-entry (204).

## The fastest way to see the system work at all

`scripts/serve.py`, then `http://127.0.0.1:8000/www/m4a.html?live=1`. One kernel, one window, one
shell, no proofs — `/usr/bin/sh` in its own process on a real pty, prompt in about 80 ms. Click the
terminal and type. `ls /usr/bin`, `ps`, `kill %1`, Ctrl-C and Ctrl-D all work.

**M6 is visible from that prompt**, which is the only answer to "is the interactive shell in the
stripped realm too?" that comes from inside the realm:

- `/bench/m6-realm/program.mjs p_show` — prints every binding the process cannot reach, and the
  syscall channel still answering. Needs no arguments and writes nothing.
- `/bench/m6-realm/program.mjs p_fault` — the bypass snippet with no try/catch. The process dies
  of SIGABRT and the page logs the fault with a stack.

Both are rows in `BENCH_ENTRIES` (`src/kernel/providerfs.mjs`); a bench program a PROCESS spawns
needs one, because `SYS_spawn` loads from the filesystem.

## TEST A SECOND ENGINE BEFORE BELIEVING A GREEN SUITE

Twice now, in two consecutive milestones, a human opening the page found an engine split that 394
green expectations could not: M4a's `setPointerCapture` (175) and M6's `worker-src` (206). The
second one stopped every process from starting, so the system did not work at all in Firefox while
the suite was entirely green.

- **The suite drives Chrome only.** That is a recorded gap, not a surprise, and the cost is now
  measured twice.
- **Firefox is drivable for a bench without CDP.** Mozilla removed CDP support, but
  `firefox --headless --screenshot` renders the page — and these pages print their own log as
  text, so the PNG is readable evidence. Hold the load event open with a slow subresource or the
  capture lands before the page has finished. `bench/m6-realm/` has no Firefox harness yet; the
  method is written down here because it took longer to find than to use.
- **A negative control doubles as a diagnostic.** `serve.py --no-csp` separated "the policy" from
  "something else" in one run. Build the switch when you build the subject.
- **A worker that will not start reports NOTHING useful** — empty message, no filename, line 0 —
  so the kernel can only say `process N runtime: error`. If you see that string, suspect the
  worker's own response headers or its module graph, and reach for `--no-csp` first.

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
  earlier run accumulated 136; an M4a session found 20 left by its own runs.
  **WAIT TEN SECONDS, NOT FIVE.** Measured by the M5 session: a run started five seconds after
  `pkill` came back BROKEN on three checks with `connection closed mid-frame`, and ten seconds was
  reliable. `pkill` returns before Chrome is gone, and constraint 121's flake has the same
  signature — so a single red immediately after a kill is unmeasured, not a failure.
- **Read `sysctl vm.swapusage` before believing any browser result.** M4a could not run
  `scripts/check.py` AT ALL for a stretch: swap read 24.2 GB of 23.5 GB used with ~390 MB free and
  Chrome was killed mid-run every time, which arrives as exit 144 and as BROKEN checks reporting
  `socket is already closed`. The harness fails closed and says it measured nothing, which is the
  correct outcome and easy to misread as a defect in the change under test. At 14.6 GB used the
  same gates passed unchanged.
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
