#!/usr/bin/env python3
"""Final edits: ABI growth without a generator, D16's rationale, the proposed-constraint queue."""

def patch(path, old, new, label, marker=None):
    s = open(path).read()
    if marker and marker in s:
        print(f"  skip {label}")
        return
    assert old in s, f"anchor: {label}"
    open(path, 'w').write(s.replace(old, new, 1))
    print(f"  ok   {label}")


# ---- 1. M1: the ABI growth item, WITHOUT a generator ----
patch('MILESTONES.md',
"""> One thing deliberately *not* added: the "not responding" detector.""",
"""> **(e) The ABI needs a growth mechanism, and it is cheapest now.** AROS's ABI v1 break — a
> one-year estimate still producing forks a decade later — was *entirely* representation
> decisions: where a handle lives, what unit a pointer counts in, how state is partitioned. The
> analogues here are the SAB layout, the futex word's position, the `(lo, hi)` pairing and the
> `r0 < 0 && r1 == -1` convention. Three parts:
>
> - **A format magic and a version word in the SAB frame header.** Four bytes, impossible to
>   retrofit, and the harness is a second consumer of that format. Haiku reads four message
>   dialects through one dispatcher on exactly this.
> - **Retired call numbers stay reserved**, and one `perform(opcode, struct)` escape hatch exists.
>   Haiku added eight `BView` methods without touching the BeOS R5 vtable using reserved slots
>   plus one `Perform()`. The CALLID/NR split M0 already made is the class of change this makes
>   survivable.
> - **One declaration, derived at runtime — not generated.** `src/abi.mjs` is already that single
>   declaration, and a grep for duplicate SAB offsets or syscall numbers across `src`, `bench`,
>   `www` and `scripts` comes back clean. So the kernel dispatch table is **derived from it at
>   boot**, with an assertion that every declared call has a handler.
>
>   *An earlier version of this item asked for a generator emitting the stubs and the dispatch
>   table. That was wrong: a generator is a build step, and `CLAUDE.md` forbids one. It would also
>   be the project's first. The runtime-derived form gets the same single-source-of-truth property
>   with no build step and no generated file to drift — correction from web-os-builder.*
>
> One thing deliberately *not* added: the "not responding" detector.""",
"M1 ABI growth (no generator)", marker="derived at runtime — not generated")


# ---- 2. D16's rationale is unsupported ----
patch('docs/DECISIONS.md',
"""**Exception:** M4a puts a real window on screen at day ~22, because 30 days with nothing visible is
how solo projects die.""",
"""**Exception:** M4a puts a real window on screen at day ~22.

**The rationale I first gave for that exception does not survive the evidence.** I wrote "30 days
with nothing visible is how solo projects die." The release record says otherwise: **SkyOS** had by
far the most visible cadence in this family — numbered builds to 6947, a paying beta from 2003,
compositing demos in 2006 — and stopped in 2009. **Haiku** went five years and eleven months with
no release at all, in its own words, and still ships. The reading is `inferred`, n=4, across
projects differing on many axes at once, and no source was found that tests it.

The better-evidenced ground is the **AtheOS** record, where the author's own farewell names
tiredness, a theory course, flying lessons, a plane and a dead PC, with a fork as what finished it.
So the defensible claim is narrower and more useful: **a solo author's motivation is a load-bearing
component with no redundancy.** M4a is therefore a promise to the *author*, not to an audience —
and the same evidence is the argument for `MILESTONES.md`, this file and `PLAN.md` §10 existing at
all, because the plan has to survive a multi-week gap.

The decision stands unchanged: M4a is two days and it deletes its own special case.
`research/09-hobbyist-os-actions.md`, D16.""",
"D16 rationale", marker="does not survive the evidence")


# ---- 3. PLAN.md: the reviewable queue ----
patch('PLAN.md',
"""## 10. Honest gaps""",
"""## 9b. Proposed constraints, queued for review

`docs/research/09-hobbyist-os-actions.md` proposes 22 constraints (numbered 52–73 there) from a
survey of 18 hobbyist operating systems. **They are not accepted.** The researcher labelled them a
proposal, and this project's own rule is that every finding is verified against the code before it
is acted on — two rounds have now produced a confident finding that was wrong on the code.

**Accepted and landed** (the three that were sequencing claims, cheap now and expensive later):

| | Landed as |
| --- | --- |
| A syscall that must wait must not hold the kernel thread | **M0a**, and constraint 57. M0's ACCEPT is a figure about a mix containing no I/O: its in-handler mean was 2.1–3.3 µs against `createSyncAccessHandle` at 495 µs, so 150–250×. The fallback is a kernel-side I/O worker, not a sharded kernel — much smaller, and legal under constraint 15 because the handles stay kernel-side. |
| File data is not journalled, only metadata | **M2 days 5–8.** Blobs mutate in place, so a torn blob leaves intact metadata pointing at it — ext4 `data=writeback`, which is not ext4's default precisely to avoid this. COW the blob or declare the guarantee metadata-only. |
| The ABI has no growth mechanism | **M1 (e).** Format magic + version word, reserved numbers, one `perform` hatch. Derived at runtime, not generated — a generator would be a build step. |

**Also landed, as corrections rather than new constraints:** the taskbar cannot be an ordinary
client of the same ABI (`CLAUDE.md`); D16's rationale (`docs/DECISIONS.md`); M8 gates M12 rather
than following it, and M7 is missing the destroy cascade and cross-process ownership
(`MILESTONES.md`).

**Queued, in the order I would review them.** Each needs checking against the code before it
becomes normative:

1. **A process is single-threaded by construction** — one futex word, one outstanding call, and M6
   deletes `Worker`. So no coroutine runtime, no background decode, and `await prompt()` as
   straight-line code is inexpressible. Constraint 20a's deadlock is a *special case*, and the
   remedy is the general one: concurrency inside an app costs a second process, charged against
   the cap. **Free to write down, and it changes the cap arithmetic for every app not yet
   designed** — so this is first in the queue.
2. **The per-process event backlog has no bound and no defined overflow** — constraint 9's unnamed
   sibling. A process parked in `Atomics.wait` cannot drain, so the kernel must buffer, unbounded.
   HelenOS's answer: a fixed in-flight budget with a synchronous `ELIMIT`, as part of the ABI
   contract rather than an implementation detail.
3. **Capabilities that can only narrow** — the credential carries `caps` with nothing reading it.
   A bitmask in the process table, a `pledge`-shaped call that only clears bits, checked at
   dispatch. The asserted invariant is **monotonicity**, not a symptom. This is a genuine boundary
   against a confused-deputy bug in a first-party app, which is this project's actual threat model,
   in a way that deleting `fetch` inside the worker is not.
4. **Durability on one call, not the journal** — EROS/KeyKOS carries an escape hatch committing one
   page immediately because database logs cannot wait. Define durability on `fsync` of one fd,
   measure *that*, and let everything else ride the snapshot. This turns §10's unanswerable
   question about the whole design into one measurement.
5. **The superblock needs a generation counter and a major/minor version** — "minor newer than me ⇒
   refuse". Three copies, not two: against two alternating slots, a bad write to the older slot
   during a commit can leave zero valid copies. Then constraint 28's "mounts read-only and reports"
   can become "mounts the previous generation read-write and reports" for the same honesty. **The
   version field is unavailable later.**
6. **An invariant must abort loudly in dev builds** rather than be documented as a rule, each abort
   owing a `--prove-failure` control. Three systems independently say so. Implies a policy not yet
   made: which of the 68 calls return an errno and which fault the process.
7. The window-protocol items — repaint from server-held state with two damage sets, server-drawn
   chrome, a global window cap with its own errno, a "not responding" detector. All M7–M12, all
   reviewable when that half starts.
8. **Pin the browser surface in writing** — the APIs and the version the spine depends on, as one
   list, so drift arrives as a diff rather than a bug report. SkyOS died because "catching up with
   the development for all this is just not possible anymore… not for one person", and its drivers
   are our browser APIs.

**Proposed D17 — window surface ownership.** Kernel-allocated retained surfaces with a serial,
versus M8's transferred `OffscreenCanvas`. Haiku and SerenityOS chose opposite sides. The terms
here favour server-allocated, because it is the only version giving accounting and revocation —
which constraint 49's admission controller and constraint 17's cap both need and neither has.
Decide before M8, because M8 gates M12.

## 10. Honest gaps""",
"PLAN.md proposed-constraint queue", marker="Proposed constraints, queued for review")

print("done")
