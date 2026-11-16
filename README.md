# web-os

A browser-hosted operating system. Windows 7 surface, Linux-shaped runtime: processes with pids, a
syscall ABI, a POSIX-ish filesystem, a real shell.

No kernel yet. This is the research, the plan, and a verified environment to build it in — in that
order, deliberately. The predecessor ([webxp](https://github.com/nchafy/webxp)) was built first and
designed afterwards, and became a very good window manager that was not an operating system.

```sh
scripts/serve.py          # then open http://127.0.0.1:8000/
```

That serves a preflight which checks the seven capabilities the kernel needs and refuses to
proceed if any are missing. `scripts/serve.py --no-isolation` makes it fail on purpose, which is
how you know it works.

## Read in this order

| File | What it is |
| --- | --- |
| [CONTEXT.md](CONTEXT.md) | **Start here if operating systems are new.** What a kernel, process and syscall are; why a browser makes this hard; what the other web OSes do; what the predecessor got wrong. |
| [PLAN.md](PLAN.md) | Three options, the shared 30-day spine, and why the order is the order. |
| [MILESTONES.md](MILESTONES.md) | The tracker. What is done, what is next, the proof each milestone owes. |
| [CLAUDE.md](CLAUDE.md) | Working rules for this codebase. Architecture invariants, conventions, verification discipline. |
| [docs/LEARNING-MODE.md](docs/LEARNING-MODE.md) | Option D — the learning mode: an interactive drill-down into every OS principle, and the RV32I teaching machine that makes virtual memory and preemption real. |
| [docs/CONSTRAINTS.md](docs/CONSTRAINTS.md) | 51 numbered constraints. Normative — cite by number. |
| [docs/designs/REVIEW-FINDINGS.md](docs/designs/REVIEW-FINDINGS.md) | 24 critiques that survived adversarial verification. |
| `docs/designs/*.md` | Four long-form candidate architectures, ~900 lines each. |
| `docs/research/*.md` | 507 cited claims across 15 files. Raw evidence; append-only. `09-hobbyist-os-actions.md` is the distilled proposal from the newest round. |

## The thesis

A kernel boundary in a browser is not a virtual machine. It is a **synchronous syscall channel from
a process Worker into an asynchronous kernel Worker**: `postMessage` out, `Atomics.wait` on a
SharedArrayBuffer for the reply. Measured here at **14–16 µs**, which is *faster* than asynchronous
message passing.

That was one caller against an idle kernel. The kernel is one thread serialising every syscall in
the system, so M0 measured the channel saturated: **p99 is 255 µs at 16 concurrent processes**
against a 500 µs bar — and 3.06 ms at 128, where queueing dominates and the sharded-kernel question
comes back. The number is worth reading only because the same harness returns `KILL` at
**29,673 µs** when a 2 ms stall is put in the kernel handler. `docs/CONSTRAINTS.md` constraint 51.

That one mechanism is what daedalOS, OS.js, win32.run and RipenOS all lack, and building it forces
everything else into existence — a process table, fd tables, pipes, credentials, and a kill that
actually kills. Running real Linux in a tab (v86, CheerpX) is a separate question with a separate
answer: it gives you a real kernel as a black box behind a serial cable, where the host cannot see
guest processes or route a window to a guest pid. It does not substitute for writing the channel.

## Where the numbers come from

Every measurement in `docs/CONSTRAINTS.md` and `docs/research/gap-04.md` was taken on Chrome
157.0.8103.38 headless, macOS 26.7.2, Apple M2 Pro, 120 Hz, dpr 2, by a harness that asserts
`crossOriginIsolated === true` before timing anything and aborts rather than report figures from a
non-isolated context. Each row names the script that produced it.

Published figures from elsewhere are labelled as such. Claims that could not be verified live in
the `could_not_determine` sections of the research files and in `PLAN.md` §10 — not quietly
dropped. One 4× arithmetic error made during planning is recorded, with its correction, in
`docs/CONSTRAINTS.md` constraint 49 and `PLAN.md` §9.

## What is already verified

- **The environment.** `www/index.html` proves isolation, SAB, `Atomics.wait` in a worker, and an
  OPFS sync access handle, in the context each has to work in.
- **The syscall channel, under contention.** M0: a kernel Worker, process Workers it spawns itself
  as nested workers, and the SAB ABI, measured closed-loop at N ∈ {1, 4, 16, 64, 128}. ACCEPT.
  `bench/syscall-contention/`, and `scripts/check.py --negative kernel-stall` keeps the negative
  control re-runnable.
- **The harness.** `scripts/check.py` — one registry, `--prove-failure`, and twenty negative controls over ten checks and 394 expectations.
  Every row of its own failure-mode table has been shown firing; a row whose detector cannot fire is
  the defect that table exists to forbid.
- **There is a working terminal, and you can watch M6 from inside it.** `scripts/serve.py`, then
  `http://127.0.0.1:8000/www/m4a.html?live=1` — a real window with `/usr/bin/sh` in its own
  process over a real pty. `ls /usr/bin`, `ps`, `echo hi` and Ctrl-C all work. Typing
  `/bench/m6-realm/program.mjs p_show` prints what that shell's realm cannot reach, from inside
  it; `p_fault` runs the bypass snippet and the process dies of it.
- **A process cannot reach the system except through the syscall channel.** M6: a process
  worker's realm is stripped before its program text is evaluated, and a Content-Security-Policy
  on the response that creates that realm bounds its module loader — because `import(expr)` is not
  `fetch` and no scanner over program text can catch it. The hole is in the record both ways: with
  the strip skipped, a uid-1000 process that the syscall channel refuses opens the kernel's blob
  for that same file by inode and rewrites it. `scripts/check.py --only m6`, with
  `--negative no-lockdown` and `--negative no-csp` as one control per half. **Hardening, not a
  security boundary** — same-origin is not a security boundary, and the threat model for v1 is
  first-party only.
- **Map tiles survive cross-origin isolation.** `bench/coep-tiles/` loads OpenFreeMap vector tiles
  plus OpenStreetMap, OpenTopoMap and Esri raster tiles under `COEP: require-corp` with zero
  blocked requests — and carries a negative control that fires, so the zero means something.

## Mockups

The spine is built — M0 through M6, with the window half (M7 onward) still ahead. The intended shape of what is not yet built is drawn and rendered:

- [`mockups/milestones.html`](mockups/milestones.html) — what is on screen at each milestone, M0
  through M14. Honest about the first five having no user interface at all.
- [`mockups/learning-mode.html`](mockups/learning-mode.html) — the three learning-page types
  (live, absent, and the coverage matrix across 35 OS principles).

`mockups/shoot.py` renders both in headless Chrome and **exits non-zero on a JS error** — a mockup
with a broken script is worse than no mockup. `scripts/check_links.py` asserts every repo-relative
path in an authored doc resolves.

## Requirements

A Chromium-based browser, and Python for the tooling — stdlib only, except `websocket-client` for
the CDP harnesses. Verified on Python 3.8.19 and Chrome 157 on macOS 26.7.2. No build step, no
framework, and no dependencies at all in the shipped code.

```sh
python3 -m venv .venv && .venv/bin/pip install websocket-client
.venv/bin/python bench/coep-tiles/probe.py
```

`python3 -m http.server` **will not work** — it cannot send `COOP`/`COEP`, so `SharedArrayBuffer`
is undefined. For the same reason this cannot be hosted on GitHub Pages or bare S3; Cloudflare
Pages, Netlify, Vercel, Firebase and CloudFront all can.

## Licence

MIT. See [LICENSE](LICENSE).
