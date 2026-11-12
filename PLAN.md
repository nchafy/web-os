# web-os — the plan

Windows 7 surface, Linux-shaped runtime, in a browser tab.

Three options. They are not three different systems: **the first 30 working days are the same in
all three**, so the choice gets made with working code in hand rather than from a document now.
What differs is what gets built on top of the same kernel, and each gives up something real.

Evidence is in `docs/research/` — 374 cited claims across 13 files: 192 exploration findings and 182
claims from the gap-closing round, each labelled measured, spec-normative, documented, inferred or
unverified. The normative distillation is
`docs/CONSTRAINTS.md` — 51 constraints every option must satisfy. The long-form candidate designs are
in `docs/designs/`, and `docs/designs/REVIEW-FINDINGS.md` holds the 24 findings that survived an adversarial
verifier whose default was to refute.

This plan has itself been through that mill: four critics, 20 findings, 10 confirmed. §9 lists what
they changed.

---

## 1. The decision

| | **A — Narrowgate** | **B — Glasswine** | **C — Fidelity First** |
|---|---|---|---|
| **The bet** | The kernel boundary *is* the product | "Linux-like" must mean real binaries run | The surface is the product |
| **A process runs** | JS in a Worker | unmodified `wasm32-wasip1` binaries | JS in a Worker |
| **Syscalls** | ~40 | 68 + a WASI preview1 shim | ~44 |
| **Aero** | DOM + `backdrop-filter`, frame-only glass | same | Canvas/WebGL compositor, the real additive composite |
| **Thumbnails / Peek** | static icon | static icon | live, from the compositor's own textures |
| **Effort** | **70 working days** | **~135 working days** | **~170 working days** |
| **Gives up** | no real binaries; Peek is fake | 2× the time; still no live thumbnails | no WASM; abandons all of `webxp/src/*.mjs`; the least-verified assumption in the set |
| **Riskiest assumption** | a single-threaded kernel stays fast under contention — **unmeasured** | a stock wasip1 binary runs unpatched over this ABI | the exact Aero composite is reachable from CSS |

**Calendar, converted once.** 70 working days — 2.5 setup + 30 spine + 37 window half — is ~14
weeks full-time, ~8 months at two days a week, ~16 months at one. Every other figure in this
document is in **working days**; multiply once, using your own cadence, and write the answer at the
top of §8's table.

**Recommendation: start A.** Not because B and C are wrong, but because A's first 30 days are also
B's and C's first 30 days, and A is the only one of the three that reaches a defensible operating
system in a single-digit number of weeks of actual work. B and C are then extensions chosen at the
end of the spine. A fourth candidate — a real Linux guest under the host kernel — should be
demoted; §7 says why.

---

## 2. Day zero (half a day)

M0 is the milestone that can invalidate everything, so nothing should stand between you and it.
Three things do: a directory tree, a server that sets the isolation headers, and a driver.

```sh
cd ~/claude/web-os
git init
mkdir -p src scripts bench www
cp ../webxp/scripts/cdp.py scripts/cdp.py
```

**`scripts/serve.py`** — ~30 lines. A `ThreadingHTTPServer` whose `end_headers` emits:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

Without both, `SharedArrayBuffer` does not exist and **nothing in this plan runs** (constraints
30–32). The first line of `www/index.html` must be an assertion that `crossOriginIsolated === true`
and a refusal to boot otherwise — a kernel that silently degrades to a non-isolated context is the
worst outcome available, because every benchmark still reports a number.

**This is a product decision, not a deploy detail, and it is being made here:** `require-corp` is
the only Safari-portable value, so every font, icon and asset is self-hosted, every remote image
carries `crossorigin="anonymous"`, and **there are no third-party iframe embeds — ever**. No
YouTube, no Google Maps, no OAuth widget inside the desktop. Hosting is Cloudflare Pages, Netlify,
Vercel, Firebase or CloudFront; **GitHub Pages and bare S3 cannot serve this** except via
`coi-serviceworker`, which costs an unconditional reload and leaves the first paint un-isolated.

---

## 3. The harness, before anything else (2 days)

`webxp/scripts/check.py` is 82 checks in 11,991 lines. **59 of them are not geometry assertions** —
`check_boot`, `check_mount`, `check_mount_index`, `check_filesystem`, `check_fs_persistence`,
`check_terminal`, `check_routes`, `check_manifest_current`, `check_launch_all`, `check_broken_app`
and others. Three of those are literally the spine's own acceptance criteria below, so the harness
is not something to port after the window manager exists; it is day-one infrastructure.

- **Day 1:** `cdp.py` plus the mechanics — the console-error drain, the screenshot clip, `--only`,
  and **`--prove-failure`**, which inverts the assertion of every check in an `INVERTIBLE` tuple so
  the run must report a failure. That mechanism is the reason webxp's harness can be trusted and it
  is the single most valuable thing being carried forward.
- **Day 2:** adapt the ~6 spine-relevant non-geometry checks so M2–M5 have somewhere to land.

The 23 geometry checks are **new work in the window half**, not a port — webxp's are a template,
and the Aero DOM differs enough that the selectors and the expected metrics all change.

---

## 4. The shared spine — 30 working days

Identical in A, B and C. Nothing here is discarded by any later choice, with one caveat stated
honestly at the end of this section.

### M0 — Prove the channel under contention (1 day, ~250 LoC)

Everything rests on a 14–16 µs syscall measured with **one caller against an idle kernel**.
Contention is unmeasured, and a single-threaded kernel worker serializes every syscall in the
system. If p99 collapses at 16 processes, A, B and C are all dead and the answer is a different
architecture.

- **Build:** kernel worker; N process workers spawned *by the kernel* as nested workers; the SAB
  ABI; three calls — `getpid`, `write(1,…)`, `nanosleep`.
- **Proof:** **closed-loop** saturation at N ∈ {1, 4, 16, 64, 128} — no offered rate, every process
  issuing its next call the instant the last returns — and **assert achieved concurrency**, because
  a rate-limited harness can report a clean p99 at "N=16" while the kernel never queues more than
  one. Accept if p99 at N=16 stays under 500 µs.
- **Negative control:** insert a 2 ms synchronous stall in the kernel handler. p99 must blow past
  the bar. A check that cannot fail is not a check.
- **Kill criterion:** p99 at N=16 above 2 ms → stop and reconsider a sharded kernel (one kernel
  worker per process group, VFS behind a lock) before writing anything else.

### M1 — Process lifecycle, signals, the hard cap (4 days, ~1100 LoC)

`spawn`, `exit`, `waitpid`, `kill`, `sigaction`, `setpgid`, `sched_yield`. Monotonic, never-reused
pids. Hard cap 128; the 129th returns `-EAGAIN`.

- **Signals arrive through a reserved SAB word**, checked at syscall entry. A process parked in
  `Atomics.wait` cannot service `postMessage`, so there is no other delivery path (constraint 16).
  Ctrl-C depends on this.
- **`Atomics.wait` parks with a finite re-arm interval and checks a kernel heartbeat word.**
  Unbounded, a kernel that throws wedges every process forever — and a recovery step that reloads
  the page makes the defect invisible to its own test. But a *fixed timeout* cannot separate a dead
  kernel from `sleep 100` or an idle `waitpid`, so the timeout is only the re-arm and the heartbeat
  is the liveness signal (constraint 46).
- **Teardown is split from reap.** `terminate()` returns in ~10 µs; the worker runs on for ~2.0 s.
  At the terminate call: mark dead, close fds, destroy windows, drop the taskbar button. The 2.2 s
  quarantine protects only the pid and the SAB, never the pixels (constraint 14).
- **Proof:** a process in `for(;;){}` with no syscalls dies on End Process; `kill -9` under
  contention; the 129th spawn fails cleanly; **kill the kernel worker and assert every parked
  process returns `EIO` within 2× the re-arm interval** — without reloading the page.
- **Negative control:** remove the SIGPEND check at syscall entry. Ctrl-C must stop working.

### M2 — The VFS core on OPFS (8 days, ~1400 LoC)

In-memory authoritative inode table; alternating OPFS superblock snapshots plus an append-only
journal; file data in a **flat** OPFS directory named by inode (constraint 26).

Days 1–4 are the `webxp/shared/fs/vfs.mjs` port: 1301 lines, reusing `#lookup` with `MAX_LINKS=40`,
`#may`/`#need`, the error codes, and `serialize`/`parse` as the snapshot writer and half of fsck.
Two assumptions touch nearly every method — `inode.data` becomes bytes, and `this.uid`/`this.gid`
becomes a per-call credential (constraint 29) — so this is a port with a signature change on the
whole surface, not a drop-in.

Days 5–8 are the four things the review added:

- **An inode → `{handle, refcount}` table beneath the fd table.** OPFS sync access handles are an
  exclusive lock *per file*, so a second `open()` of the same file throws
  `NoModificationAllowedError`: `cat notes.txt | wc -l` fails while an editor holds the file
  (constraint 47). The refcount also lifts the 495 µs open out of the common path.
- **Boot-lock retry longer than the abort grace.** Taking the journal's sync handle as the mutex is
  right, but a plain Cmd-R races the *previous* kernel's handle, so a normal reload intermittently
  comes up read-only. Retry ~3 s with backoff before declaring multi-tab (constraint 48).
- **`fsync` separate from `write`**, journal flushed on fsync, snapshot and idle — never per
  mutation, which is ~520 µs against a 5 µs write (constraint 23).
- **fsck never reseeds.** A bad superblock CRC mounts read-only and says so. webxp resets on a bad
  image; that must not survive into a filesystem holding real work (constraint 28).
- **Proof:** write 10k files, reload, every byte and every mode bit intact (`check_fs_persistence`
  adapted); truncate the journal mid-record and assert fsck **reports the discarded tail** rather
  than reseeding; two concurrent opens of one file both succeed.
- **Negative control:** drop the data-before-metadata ordering. fsck must report corruption. Then
  break the CRC check and confirm the torn-journal test starts passing — if it passes either way it
  is testing nothing.

### M3 — `/proc`, `/dev`, mounts (2 days, ~450 LoC)

Longest-prefix mount table, static at boot. `/` on OPFS; `/usr` read-only from a build-time JSON
index (daedalOS's `fs2json` shape, which already carries the mtime and symlink targets OPFS lacks);
`/tmp` tmpfs; `/proc` and `/dev` generated on read.

`/proc/<pid>/{status,cmdline,cwd,fd/<n>}` is ~120 lines and is the clearest demonstration that a
process is a first-class object. `cat /proc/4/status` reading the same table the taskbar reads is
the moment this stops being a website.

- **Proof:** `ls /proc` enumerates live pids; killing one makes its directory vanish
  (`check_mount`, `check_mount_index` adapted).
- **Negative control:** stop regenerating `/proc` on read and serve a cached listing — the killed
  pid must linger and the check must fail.

### M4 — Pipes, pty, the line discipline (5 days, ~1000 LoC)

`pipe2`, `dup2`, process groups, and **the line discipline in the kernel, not the terminal widget**
— `ICANON`, `ECHO`, `ISIG`, `VINTR`/`VQUIT`/`VSUSP`. Ctrl-C raises SIGINT on the foreground process
group even when the UI is wedged, which is the entire point of putting it there.

A reader blocked on a pipe whose last writer was terminated completes with **0, meaning EOF** —
not an errno. A blocked *writer* whose last reader died is the case that gets `-EPIPE` plus
`SIGPIPE`. Both wakes come from the kernel (`docs/ABI.md` §5). Every
byte of IPC crosses the kernel worker: a direct worker-to-worker ring would be faster and would
make that wake impossible (constraint 15).

- **Proof:** `yes | head -1` terminates; Ctrl-C during `sleep 100 | cat` kills both; a writer
  killed with `-9` makes its blocked reader return 0 (EOF), and a writer whose reader died gets
  `-EPIPE`.
- **Negative control:** stop delivering SIGPIPE. `yes | head -1` must hang.

### M4a — The terminal gets a real window (2 days, ~200 LoC)

Not in the original candidate, added because the alternative is **30 days with nothing on screen**,
which is how solo projects die. `webxp/src/window.mjs` (836 lines) already does 8-edge resize,
drag, minimise, maximise and focus. Drop it in unstyled and point it at the pty.

**This window is special-cased, not an ABI.** M7 generalises it and deletes the special case. Say
so in the code, or it will quietly become the architecture.

- **Proof:** `check_terminal` adapted — type into the window, assert the pty echoed it.
- **Negative control:** detach the pty; the keystroke must not appear.

### M5 — The shell and the first ten programs (6 days, ~1200 LoC)

`webxp/apps/terminal/shell.mjs` (453 lines — tokenize, parse, expand, complete) keeps its front
end; the executor is rewritten from in-realm calls into `commands.mjs` to `pipe2` + `spawn` with
`posix_spawn`-shaped file actions. The rewrite is against the **1,941-line** shell+commands pair,
not the 453-line parser.

The ten programs in `/usr/bin` — `ls`, `cat`, `echo`, `wc`, `head`, `grep`, `sleep`, `kill`, `ps`,
`true` — are **mostly new code**. webxp's 1,488 lines of builtins contain roughly 230 lines across
the six that correspond; `kill` and `ps` have no webxp equivalent at all, because webxp had no
process table. Budget them as writing, not harvesting.

There is no `fork` (constraint 20 — re-examined, and its reasoning corrected; see §10). Pipelines,
background jobs, job control and `$(…)` all survive on `spawn` + `pipe` + `setpgid`, and
`( subshell )` in-process is *more* POSIX-conformant for `$$`, `$!` and `PPID` than a spawned one.

**The real casualty is `f | g` where both sides are shell functions.** One Worker cannot run both,
and serialising deadlocks once the kernel pipe buffer fills. Every fork-free shell buys this back
with a thread or a state-carrying re-exec (hush's `re_execute_shell`; busybox-w32's
`spawn_forkshell`, ~730 lines). **Budget a second shell worker, or accept the deadlock and document
it** — constraint 20a. Note also that `fg`/`bg`/`^Z` are limited by `Worker.terminate()` and
constraint 21, not by fork; an earlier draft credited them to `spawn` without naming that bill.

- **Proof:** `ls /usr/bin | grep c | wc -l` returns the right count through three real processes;
  `sleep 60 &`, then `ps`, then `kill %1`.
- **Negative control:** make `spawn` return the parent's pid. `ps` must show one process and the
  check must fail.

### M6 — Neuter the process realm (2 days, ~300 LoC)

**The finding that nearly killed the premise.** A process worker is a same-origin dedicated worker,
so it holds *ambient* OPFS access:

```js
const r = await navigator.storage.getDirectory()
const b = await r.getDirectoryHandle('b')
const h = await (await b.getFileHandle('17')).createSyncAccessHandle()
h.write(new Uint8Array(4096))
```

That writes inode 17's blob directly, bypassing the credential, the mode bits and the syscall
channel entirely. Confirmed as applying to **every** design in the candidate set. The boundary this
whole project exists to build is decorative until it is closed.

`libos.mjs` neuters the realm before evaluating program text: delete the
`WorkerNavigator.prototype.storage` getter, and `fetch`, `XMLHttpRequest`, `importScripts`,
`indexedDB`, `caches`, `WebSocket` and `Worker` (constraint 41).

- **Proof:** a program containing exactly that snippet fails, and `/proc` shows it faulted.
- **Negative control:** skip the neutering; the same program must succeed. **If it does not, the
  check is testing nothing.**
- **Honest label:** this is hardening, not a security boundary. Same-origin is not a security
  boundary and never will be. It makes accidental and casual access impossible. A determined
  attacker inside your own origin is out of scope, and the threat model is **first-party only** for
  v1, which `docs/research/gap-05.md` recommends explicitly.

**End of the spine. 1 + 4 + 8 + 2 + 5 + 2 + 6 + 2 = 30 days.**

What you have: a kernel in a worker, killable processes with pids, a journalled POSIX filesystem
that survives reload and refuses to reseed, `/proc`, pipes, a real pty with the line discipline in
the kernel, a shell running ten real programs in real processes, one visible window, and a process
realm that cannot reach around the ABI. That is already more of an operating system than any of the
four reference implementations.

**The caveat on "nothing is discarded":** true for A and B. For **C it is false** — C abandons
native DOM windows, so M4a's `window.mjs` drop-in is thrown away and the terminal is re-targeted at
a canvas surface. That is about 2 of the 30 days. Everything else survives C intact.

---

## 5. Option A's window half — 37 working days

### The ABI is ~40 calls, not 34

Stated plainly because the earlier draft of this plan got it wrong. `docs/designs/minimal-kernel.md`
reaches 34 by deleting nine calls and routing windows through a device file; this plan restores
`poll` and `dup2` (M7 needs them), adds `win_create` with a surface, and adds three `dataobj` calls.
Count it honestly at ~40 and **pick one window ABI** — the `/dev/wm` device file *or* `win_*`
calls, never both. This plan picks `win_*`, because a surface handle has to be transferred and a
device-file write cannot transfer an `OffscreenCanvas`.

| | Milestone | Days | Proof | Negative control |
|---|---|---|---|---|
| M7 | **Window as a file description.** `win_create` returns an fd; `/proc/<pid>/win/<winid>` is openable; window events are that fd's readable set; `poll()` is the single wait primitive. A process has one futex word, so a bare winid leaves a process with two windows — or a window plus a pipe — unable to be woken by both (constraint 42). Deletes M4a's special case. | 4 | one process opens two windows and a pipe, and `poll()` wakes it for each in turn | wake only on the first fd in the set; the two-window case must hang |
| M8 | **The surface.** `win_create` returns a winid *and* a transferred `OffscreenCanvas`. Without it no syscall puts a pixel inside a window, and every app that is not the terminal is a frame around nothing (constraint 43). | 3 | a process draws a known 4×4 pattern; screenshot and assert the pixels | draw nothing; the pattern assertion must fail |
| M9 | **Owner, modality, close-request.** `owner:winid`, `modal ∈ {none,window,app,system}`, and a `WIN_CLOSE_REQUEST` the X button posts rather than acts on (constraint 44). | 3 | click the owner's caption behind a modal — it must not raise; close with unsaved state — the app must get to refuse | remove the owner chain; the dialog must fall behind and the check must fail |
| M10 | **Typed clipboard and drag-and-drop**, kernel-owned. `dataobj_create(formats[])`, `dataobj_set(did,format,bytes)`, `dataobj_get(did,format)`, seeded with text, a file list and an image (constraint 45). **No candidate design had either**, and they are the two gestures that make a set of windows read as one system. | 4 | drag a PNG from Explorer into an image view and assert the bytes arrived under the image format; copy an image and paste it | offer only the text format; the image paste must fail cleanly, not silently paste a path |
| M11 | **Aero glass, frame-only**, plus the reskin of `window.mjs`/`desktop.mjs`/`dialogs.mjs`/`widgets.mjs`/`contextmenu.mjs` from XP Luna. Glass on caption and border ring, opaque client area — both more faithful to Win7, whose own rule allows glass only in "small regions touching the window frame without text", and ~11× cheaper. | 5 | **sample a 16 px column across a black/white backdrop seam behind the caption and assert a monotonic gradient** | set `backdrop-filter: none`; the gradient assertion must fail |
| M12 | **The blur governor** as an admission controller over every area-changing event — open, maximize, snap, restore, un-minimize, peek — degrading by z-order from the bottom, accounting the **border box** (constraint 49). | 3 | **drive it into its degrade branch**: open 52 glass terminals at 640×440 (53.7 M device px), assert the flatten count is non-zero and that frame rate holds ≥110 fps | disable the governor at the same geometry; frame rate must drop below 110 fps |
| M13 | **The geometry harness** — the 23 new geometry checks. This is the only proof M7–M12 have, and it is new work, not a port (§3). | 5 | `--prove-failure` inverts every one and the run must report failures | — |
| M14 | **Aero Snap, Superbar, jump lists, tray.** Snap arms at 1 px of pointer-to-edge, releases at 20 px of drag-out, 50 px side-move to restore a top-maximized window. Both edges of every threshold get checked, because a threshold on a continuous input without hysteresis oscillates. | 6 | drag to 1 px and assert the snap; drag out 19 px and assert it holds; 21 px and assert it releases | remove the hysteresis band; the 19 px case must start failing |
| — | **Icons and fonts.** Win7 icons and glass bitmaps **must be redrawn** — shipping Microsoft assets is not an option. Segoe UI is not redistributable, Selawik is **not** documented as metric-compatible, so every layout is measured against both (constraint 37). | 4 | contrast and fit re-checked on every surface the glass sits under | — |

**37 days. With the 2.5 setup days and the 30-day spine: 70.**

---

## 6. Options B and C

**B — Glasswine (+65 days, ~135 total).** Everything in A plus unmodified `wasm32-wasip1` binaries
as processes: a preview1 shim over the ABI, a per-process bounce buffer, a package format. The
payoff is `busybox` or a real compiler running in a window. Read `docs/designs/wasi-userland.md` first:
its riskiest assumption is that a stock wasip1 binary runs unpatched at full speed over this ABI,
and three independent things could each falsify it. Note that Browsix already proved the obvious
transport dead — mapping the process heap as the SAB did not survive a WebAssembly target — and its
replacement bounce buffer measured 0.2% average overhead, so build that (`docs/research/gap-02.md`).

**C — Fidelity First (+100 days, ~170 total).** Everything in A plus a Canvas/WebGL compositor that
owns the backdrop and renders the real additive composite per frame — which makes live thumbnails
and genuine Aero Peek free, because the compositor already holds every window as a texture. The
case for it is real: the authentic highlight is a bitmap anchored to the *monitor*, parallaxed at
0.1, which wants a compositor rather than per-window CSS. The case against is that its riskiest
assumption is the least verified in the research set — that `backdrop-filter: blur(9px)
url(#aero-glass)` applies a referenced SVG `feColorMatrix` in sRGB — and taking C discards all of
`webxp/src/*.mjs`.

**If C tempts you, spend one day spiking that assumption before the end of the spine, not on month
four.**

---

## 7. The fourth candidate, and why it is demoted

A real Linux guest (v86) as one process under the host kernel, sharing a filesystem over 9P so host
and guest see one tree. Designed in full at `docs/designs/hybrid-guest.md`, 133 days. Two concrete
protocol defects and one framing problem:

- **Linux 2.6.34 — the kernel in the measured v86 Buildroot image — has no 9P2000.L operations at
  all.** Its message enum stops at the 9P2000.u set, so the entire `.L` server (`Tlopen`,
  `Tgetattr`, `Tsetattr`, `Treaddir`, `Treadlink`) is a dialect the guest cannot speak. The protocol
  was chosen from memory rather than against a kernel. *A newer image fixes this* — the defect is
  the method, not the approach.
- **`Tflush` was absent**, but virtio-9p sends it on *every* interrupted request and then waits for
  `Rflush`. Ctrl-C on a parked `Tread` wedges the guest.
- And the framing: a full-system emulator is **a black box behind a serial cable**. The host cannot
  see guest processes or route a window to a guest PID. Running real Linux does not buy a kernel
  boundary; writing the syscall channel does.

So: **the guest is a very good app, not a load-bearing part of the OS.** Ship it after M14 as one
process that happens to contain Linux. It is a genuinely impressive window and it costs weeks
rather than months, because as *an app* it needs no protocol work at all.

---

## 8. Order of risk

The riskiest assumption is tested first in every option, which is the one scheduling rule that
matters.

| Working day | What is tested | If it fails |
|---|---|---|
| 0.5 | isolation headers — is `crossOriginIsolated` true? | nothing in this plan runs; fix the server first |
| 3 | M0 — does a serialized kernel survive contention? | shard the kernel, or abandon the single-kernel design |
| 4–7 | M1 — can a compute-bound process be killed, and does a dead kernel yield `EIO`? | the boundary is not real; stop |
| 8–15 | M2 — does the filesystem survive a reload and a torn journal? | reconsider the store before anything is built on it |
| 22 | M4a — is there something on screen? | morale, not correctness — but it is the one that ends solo projects |
| 32 | M6 — can a program reach around the ABI? | closed by then, but the negative control must prove it |
| 33 | the A / B / C choice | made with working code, not from a document |
| 55 | M12 — does the governor's degrade branch actually fire? | the glass budget is unmanaged on any smaller GPU |

**Kill criteria, observable and early:** p99 syscall latency above 2 ms at 16 processes (day 3); a
compute-bound process that survives End Process (day 7); boot-to-usable-FS above 2 s at 10k inodes
(day 15); **the governor failing to flatten anything at 52 glass terminals** (day 55 — note the
gate is at 52 windows, not 5; five maximized windows are 18.4 M device px, comfortably under the
58–63 M wall, so a gate sized at five would pass by construction).

---

## 9. What the critics changed

Four lenses over this plan, 20 findings, 10 confirmed after adversarial verification. The ones that
changed the document:

1. **A 4× arithmetic error, propagated into a normative constraint.** An earlier draft asserted that
   five maximized glass windows are 73.7 M device px and therefore past the blur wall. That applies
   dpr² twice; the real figure is 18.4 M, and `docs/CONSTRAINTS.md` constraint 36 — a measured one — puts
   the wall at ~13 full-screen windows, which contradicts it within the same file. Worse, the only
   Aero kill gate was sized from it, so the gate was **structurally incapable of failing**: exactly
   the defect class constraint 39 exists to forbid. Constraint 49 is corrected and the gate is now
   52 windows.
2. **`check.py` does not "port almost unchanged", and it is also not 82 geometry checks.** The first
   draft said the former, a critic corrected it to the latter, and the latter is also wrong: 59 of
   the 82 are not geometry assertions, and several *are* the spine's acceptance criteria. The
   harness is now §3, 2 days, before M0.
3. **Option A's ABI is ~40 calls, not 34**, once `poll`, `dup2`, a window surface and the data
   objects are restored. The earlier draft kept the source design's headline number while importing
   work it had explicitly deleted. And it mixed two window ABIs; now it picks one.
4. **M7–M12 had no proofs and no negative controls** — 20 of the days and the entire visible
   product, unchecked, while the harness that would check them had been cut. §5 is now a table in
   which every row has both.
5. **The arithmetic did not add up.** Milestones summed to 22 against a stated 30; "inside one
   quarter" and "GUI apps by week 8" were both wrong at any realistic cadence. Days now sum, and the
   calendar conversion happens once, in §1.
6. **Day one could not be executed.** The `cp` targeted a directory that did not exist, and there
   was no COOP/COEP server at all — so M0, the milestone that can invalidate everything, could not
   have run. §2 is rewritten.
7. **The deployment decision was being made silently.** `require-corp` means no third-party embeds
   ever and every asset self-hosted. That is a product cut, and it is now stated in §2 where it is
   visible rather than buried in the research.
8. **Nothing was visible for 30 days.** M4a puts a real window on screen at day ~22, flagged as a
   special case that M7 deletes.
9. **The "finding N" cross-references did not resolve.** They are gone; constraints are cited by
   number against `docs/CONSTRAINTS.md`, which is stable.
10. **M5's programs are mostly new code.** webxp's 1,488 lines of builtins contribute ~230 across
    six programs, and `kill` and `ps` have no equivalent because webxp had no process table.

What the critics explicitly told me not to touch: **M0** (right assumption, right day, real kill
criterion, a negative control that must fire) and **M6** (concrete exploit, enumerated fix, the
correct negative control, and an honest label). Both stand unchanged.

---

## 10. Honest gaps

Not resolved, and load-bearing:

- **`fork` was re-examined and the constraint's reasoning was wrong.** It is not that Browsix
  found fork incompatible with blocking syscalls — it found no way to spill a call stack except
  Emterpreter, and said SharedArrayBuffers plus a `setcontext` equivalent would have made fork a
  *synchronous* syscall. Asyncify shipped that in 2019, and fork was demonstrated working in
  Chrome 157 twice for this project. The constraint stands because a JS process cannot be
  snapshotted at all, a stock wasip1 binary needs rebuilding, and the cost is a whole-heap memcpy
  on the kernel's own thread (16.6 ms at 64 MiB). `docs/research/gap-07-fork.md`.
- **Kernel contention is unmeasured.** M0 exists to fix that on day 3. Everything downstream assumes
  it passes.
- **Whether `Atomics.notify` can interrupt a worker inside a synchronous OPFS call.** By inspection
  it cannot, which would mean a read against a slow file is not interruptible even though the ABI
  marks it so. The weakest point in the cancellation design; wants a measurement before M4
  (`docs/research/gap-03.md`).
- **Whether an OPFS journal append plus `flush()` is genuinely durable across a kill.** The spec
  says "attempt to transfer", with an explicit no-op case. The fsck design assumes the tail can
  always be torn (`docs/research/gap-06.md`).
- **Whether OPFS falls under WebKit's seven-day deletion of script-writable storage.** No source
  found either way. A Safari user may simply lose the filesystem (`docs/research/gap-06.md`).
- **The blur budget on other hardware.** One machine, one 120 Hz panel, dpr 2. A 60 Hz display has
  twice the per-frame budget; an integrated GPU has far less (`docs/research/gap-04.md`).
- **Whether Selawik is metric-compatible with Segoe UI.** Not documented, not claimable, and not
  measurable here — Segoe UI cannot legally be obtained for the comparison (`docs/research/gap-05.md`).
- **The per-origin cost figures are n=1.** Chrome isolates by site, so ports do not count, and only
  `127.0.0.1`, `localhost` and `[::1]` are distinct sites on loopback without root. The 68–80 MiB
  and ~80 ms cold-start numbers that rule out per-app origins rest on two samples
  (`docs/research/gap-04.md`).
