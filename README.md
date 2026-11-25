# web-os

A browser-hosted operating system. Windows 7 surface, Linux-shaped runtime: processes with pids, a
syscall ABI, a POSIX-ish filesystem, a real shell.

Research and plan first, kernel second — deliberately, and in that order. The predecessor
([webxp](https://github.com/nchafy/webxp)) was built first and designed afterwards, and became a very
good window manager that was not an operating system.

**M0 to M17 are done, which is the whole spine and the whole window half**: the syscall channel,
the process table, the journalled filesystem, the mount table with `/proc`, `/dev`, `/tmp`, `/usr`
and `/usr/share`, pipes, a pty with a line discipline, a shell and the 33 programs in `/usr/bin`
behind it, the realm stripped of its ambient capabilities — and then a window that IS a file
description, a kernel-owned surface a process draws on by sending a display list,
modality and an advisory close,
a typed clipboard and drag-and-drop, Aero glass as four separately filtered strips, an admission
controller over blurred area, a geometry harness that drives a real pointer, Aero Snap, the
Superbar, jump lists, a tray, a desktop whose icons are rows a PROCESS published, a client box in
device pixels, and a driven wheel over a list that scrolls and clips.

```sh
scripts/serve.py          # then open http://127.0.0.1:8000/www/
```

**That URL is the desktop.** Not a milestone page and not an index of them: the preflight runs,
and then the Windows 7 shell comes up with a terminal, Explorer, the task manager and the icon
view on it. Double-click an icon, use the Start orb, drag a caption to an edge to snap it,
right-click a taskbar button for its jump list, drag an icon and watch it take a grid cell, scroll
a directory with the wheel. Every row in that menu is `/usr/bin` as a process read it.

There is one definition of what that desktop is made of — `www/shell.mjs`, whose `PROGRAMS` and
`DESKTOP_HELP` are frozen data a feature adds a row or a line to. The landing page imports it, and
`www/m14.html` and `www/m17.html` import it for their live modes, so a program that lands lands
once. It used to be a copy of the staging on every page, which made "up to date with the latest
features" a promise kept by hand: a program added to one copy was silently absent from the rest.
That consolidation is M18 in `MILESTONES.md`.

The preflight is still in front of it: seven capabilities the kernel needs, and a refusal that
says which one is missing rather than a blank page. `scripts/serve.py --no-isolation` makes it
fail on purpose, which is how you know it works.

The proof pages stay where they are, at `www/m0.html` through `www/m17.html`, and they are the
harness's to open — not a reader's. The proofs stage their own windows and then block waiting for
a driver to perform a gesture, so a person who opens one gets fixture windows and a thrown
`nothing performed the … gesture` a minute later. It used to be the other way around, which is how
three defects came to be reported that were not defects. Any proof page says so on itself now, in
a banner, if nothing drives it. The landing page carries no proofs and reads no query string at
all, which is the clause its own check asserts.

## Read in this order

| File | What it is |
| --- | --- |
| [CONTEXT.md](CONTEXT.md) | **Start here if operating systems are new.** What a kernel, process and syscall are; why a browser makes this hard; what the other web OSes do; what the predecessor got wrong. |
| [PLAN.md](PLAN.md) | Three options, the shared 30-day spine, and why the order is the order. |
| [MILESTONES.md](MILESTONES.md) | The tracker. What is done, what is next, the proof each milestone owes. |
| [CLAUDE.md](CLAUDE.md) | Working rules for this codebase. Architecture invariants, conventions, verification discipline. |
| [docs/LEARNING-MODE.md](docs/LEARNING-MODE.md) | Option D — the learning mode: an interactive drill-down into every OS principle, and the RV32I teaching machine that makes virtual memory and preemption real. |
| [docs/CONSTRAINTS.md](docs/CONSTRAINTS.md) | 298 numbered constraints. Normative — cite by number. |
| [docs/designs/REVIEW-FINDINGS.md](docs/designs/REVIEW-FINDINGS.md) | 24 critiques that survived adversarial verification. |
| `docs/designs/*.md` | Four long-form candidate architectures, ~900 lines each. |
| `docs/research/*.md` | 664 distinct cited URLs across 16 files; re-derive with the `research-urls` recipe below. Raw evidence; append-only. `09-hobbyist-os-actions.md` is the distilled proposal from the newest round. |

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

- **The environment, and then the product.** `www/index.html` proves isolation, SAB,
  `Atomics.wait` in a worker, and an OPFS sync access handle, in the context each has to work in —
  and then stages the desktop. `scripts/check.py --only landing` is its gate: 17 expectations that
  derive what the desktop owes from `src/bin/desktop.mjs`'s own allowlist, `/usr/bin`'s 33 entries
  and the kernel's 6 mounts, so a program that lands and does not reach the landing page turns it
  red without anyone editing a list. `--negative launcher-stale` is that world, built by patching
  a copy of the tree rather than the tree.
- **The syscall channel, under contention.** M0: a kernel Worker, process Workers it spawns itself
  as nested workers, and the SAB ABI, measured closed-loop at N ∈ {1, 4, 16, 64, 128}. ACCEPT.
  `bench/syscall-contention/`, and `scripts/check.py --negative kernel-stall` keeps the negative
  control re-runnable.
- **The harness.** `scripts/check.py` — one registry, `--prove-failure`, and 54 named negative
  controls over 22 checks and 819 expectations; re-derive both with the `suite` recipe below.
  Every row of its own failure-mode table has been shown firing; a row whose detector cannot fire is
  the defect that table exists to forbid.
- **There is a Windows 7 desktop, and everything on it is a process.** M13 and M14, now at
  `http://127.0.0.1:8000/www/`. The icons and the start menu are rows
  `/usr/bin/desktop` published after reading the filesystem, a jump list is rows the program that
  owns the window published, and a snap is a real drag the kernel records as a show state — so the
  shell is a renderer and not an authority. `scripts/check.py --only m14` is 57 expectations over
  nine proofs, every gesture a real pointer or a real key, and `--negative no-items` has the kernel
  discard every published row: the only run that tells this apart from a page drawing a hard-coded
  menu. `bench/m14-shell/shell.py` uses the desktop and keeps the picture.
- **And `bench/m14-shell/firefox-drive.py` asks the question a reader asks first**, in a real
  Firefox with real trusted input: does every icon open a window, are the icons still reachable
  afterwards, does a start-menu row for a console program open a terminal that RAN it. It exists
  because none of those 57 expectations did — a reader twice reported being unable to open anything
  on a desktop whose Chrome suite was green (constraints 289-292). `scripts/bidi.py` is what makes
  it possible: Firefox 156 speaks WebDriver BiDi, so a second engine can be asserted in and not
  only photographed.
- **And the landing page is asked the same question, because it is the one URL a reader opens.**
  `bench/shell-landing/firefox-landing.py` is that gate pointed at `www/index.html`: it reports
  `taskbar=True orb=True` and the icons it found — `Computer`, `Programs`, `Shared files`,
  `Terminal` — double-clicks each one and watches the window count go 1 → 2 → 3 → 4 → 5,
  hit-tests every icon's own click point afterwards, and opens the start menu and launches the
  first "(in a terminal)" row, which is `cat` today and is read out of the menu rather than named
  in the script. Every clause comes out of the DOM `src/wm/` builds, so it depends on no page
  global and can be pointed at a second page. `--prove-failure` parks a window on the icon column:
  the `reachable` clause fires four times and `desktop` stays green, which is a control that moved
  a named subset and not just something.
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

The spine and the whole window half are built — M0 through M17. What remains undrawn in code is
option D, the learning mode, and its intended shape is rendered:

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

## Re-deriving the numbers

Every count in this file is a statistic, so each names the command that produces it. A number with
no reproduction path is an assertion.

```sh
# research-urls: distinct cited URLs in the raw evidence, and the file count beside it
grep -ohE 'https?://[^ )>]+' docs/research/*.md | sort -u | wc -l
ls docs/research/*.md | wc -l

# constraints: the numbered, normative ones. The count and the highest NUMBER must agree, or a
# constraint was deleted or duplicated and every citation to it is now ambiguous
grep -cE '^[0-9]+\.' docs/CONSTRAINTS.md
grep -oE '^[0-9]+\.' docs/CONSTRAINTS.md | tr -d '.' | sort -n | tail -1

# suite: registered checks, their committed expectation floors, and the named negative controls.
# `--list` prints its "measured nothing" line on stderr, so tail starts at the row after the header
python3 scripts/check.py --list 2>/dev/null | tail -n +2 | awk -F'|' '{n++; s+=$7} END {print n, s}'
python3 scripts/check.py --list 2>/dev/null | tail -n +2 | cut -d'|' -f5 | tr ',' '\n' \
  | sort -u | grep -vE '^(invert|no-isolation)$' | grep -c .
```

## Licence

MIT. See [LICENSE](LICENSE).
