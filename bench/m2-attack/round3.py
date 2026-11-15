#!/usr/bin/env python3
"""Promote the event backlog to M1; add M2a's purity scope; record the sid caveat."""

def patch(path, old, new, label, marker=None):
    s = open(path).read()
    if marker and marker in s:
        print(f"  skip {label}")
        return
    assert old in s, f"anchor: {label}"
    open(path, 'w').write(s.replace(old, new, 1))
    print(f"  ok   {label}")


# ---- 1. sid: field-plus-invariant, not a feature ----
patch('MILESTONES.md',
"""> **(b) `sid` goes in the table now**, because M4's line discipline hangs SIGTTIN, SIGTTOU and
> SIGHUP off the session. The ABI has `setpgid` and no session concept at all, so M4 would
> otherwise have to add a field to a live table.""",
"""> **(b) `sid` goes in the table now**, because M4's line discipline hangs SIGTTIN, SIGTTOU and
> SIGHUP off the session. The ABI has `setpgid` and no session concept at all, so M4 would
> otherwise have to add a field to a live table.
>
> **M1 lands the field, the leader link and `setsid` — and explicitly does not claim SIGHUP,
> SIGTTIN or SIGTTOU work.** A session id is four bytes and free; a session that *works* is not:
> SIGHUP on leader death means the kernel has to know which pid leads, keep that link correct
> across teardown, and deliver to every process in every process group in the session — and
> constraint 18 requires that sweep be O(interested), not O(N). Recorded as a field plus an
> invariant rather than a feature, so M4 inherits something true instead of something that looks
> done. *(web-os-builder's caution, taken.)*""",
"sid field-plus-invariant", marker="field plus an\n> invariant")


# ---- 2. event backlog promoted out of the queue into M1 ----
patch('MILESTONES.md',
"""> **(e) The ABI needs a growth mechanism, and it is cheapest now.**""",
"""> **(e) The per-process event backlog gets a bound and a defined overflow.** Promoted out of
> `PLAN.md` §9b on web-os-builder's argument, which corrected mine. I had filed it as "constraint
> 9's unnamed sibling". It is **strictly worse than constraint 9**: constraint 9's overflow is
> bounded by one 64 KiB SAB and visible at the call site, while this one grows without limit **on
> the kernel's own heap**, and the process that caused it is asleep in `Atomics.wait` and cannot
> drain. Constraint 17 caps processes at 128 precisely because the renderer dies between 3,200 and
> 4,800 workers; an unbounded per-process backlog reintroduces that same failure mode with no cap
> on it at all.
>
> HelenOS's answer is the cheap one and belongs in the **ABI contract** rather than the
> implementation: a fixed in-flight budget per process, with a synchronous `ELIMIT` when it is
> exhausted. Which is why it lands here with the other table fields rather than at the milestone
> that first needs it.
>
> **(f) The ABI needs a growth mechanism, and it is cheapest now.**""",
"event backlog promoted to M1", marker="strictly worse than constraint 9")


# ---- 3. M2a purity scope ----
patch('MILESTONES.md',
"""Costs no dependency and no build step — the same `.mjs` files, imported by a script. This is why
`src/abi.mjs` holding only integers and pure codecs matters: it is importable from Node.""",
"""Costs no dependency and no build step — the same `.mjs` files, imported by a script. This is why
`src/abi.mjs` holding only integers and pure codecs matters: it is importable from Node.

**Scope condition, and it is the whole value of the milestone: the host-runnable path must be the
same code, not a port.** The risk is M2's codecs reaching for OPFS or a SAB *inside* the parse path
and quietly becoming unfuzzable. So the inode table, the superblock codec and the journal codec stay
**pure over byte arrays, with all I/O at the edges**. Hold that and the fuzz target is free forever;
lose it and M2a decays into a maintained second implementation, which is the exact thing it exists
to avoid. *(web-os-builder's addition, from M0's experience with `src/abi.mjs`.)*""",
"M2a purity scope", marker="same code, not a port")


# ---- 4. PLAN 9b: record the promotion ----
patch('PLAN.md',
"""2. **The per-process event backlog has no bound and no defined overflow** — constraint 9's unnamed
   sibling. A process parked in `Atomics.wait` cannot drain, so the kernel must buffer, unbounded.
   HelenOS's answer: a fixed in-flight budget with a synchronous `ELIMIT`, as part of the ABI
   contract rather than an implementation detail.""",
"""2. ~~**The per-process event backlog has no bound and no defined overflow.**~~ **Promoted out of
   this queue into M1 (e).** I had filed it as "constraint 9's unnamed sibling"; web-os-builder
   pointed out that is an understatement. Constraint 9's overflow is bounded by one 64 KiB SAB and
   visible at the call site. This one grows without limit on the *kernel's own heap* while the
   process that caused it is asleep and cannot drain — reintroducing the renderer-death failure
   mode that constraint 17's cap exists to prevent, with no cap on it. It wants the ABI contract,
   so it lands with M1's other table fields.""",
"PLAN 9b promotion recorded", marker="Promoted out of\n   this queue")

print("done")
