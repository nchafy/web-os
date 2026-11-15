#!/usr/bin/env python3
"""Specify the ELIMIT budget as per-fd, with the invariant that keeps it coherent."""

old = """> HelenOS's answer is the cheap one and belongs in the **ABI contract** rather than the
> implementation: a fixed in-flight budget per process, with a synchronous `ELIMIT` when it is
> exhausted. Which is why it lands here with the other table fields rather than at the milestone
> that first needs it."""

new = """> HelenOS's answer is the cheap one and belongs in the **ABI contract** rather than the
> implementation: a fixed in-flight budget with a synchronous `ELIMIT` when it is exhausted. Which
> is why it lands here with the other table fields rather than at the milestone that first needs it.
>
> **The budget is charged per fd — not per process, and not per event source.** This is not a new
> concept; it falls out of constraint 42, which already made the fd the unit of *wakeability*:
> "`poll()` MUST be the single wait primitive over fds." If the fd is the unit a process waits on,
> it is the unit a budget must be charged against — otherwise the budget and the wait primitive
> disagree about what an event source is.
>
> Per *process* is wrong for the reason the OPFS finding was wrong: one chatty window consumes the
> whole budget and starves the same process's pipe events. That is head-of-line blocking across
> unrelated event classes, which is the same shape as one queue serving things with no reason to
> share a queue.
>
> Per *(process, source)* is wrong because "source" would be a second taxonomy beside the fd table,
> needing its own identity, lifetime and teardown. Per-fd gets all three free: the fd table already
> has them, `close(fd)` already releases the budget, and the two-phase teardown in (d) already walks
> the fds, so it drains the budgets in the same pass rather than needing a second sweep.
>
> It also gives the property the promotion was for: a process that floods one window's queue gets
> `ELIMIT` on **that fd** and keeps servicing its pipe. HelenOS's per-phone budget is consistent
> with this rather than against it — a phone is its connection handle, so it is the fd-equivalent
> once the handle types are lined up.
>
> **The invariant, stated so the next reader meets it: an event source that cannot be charged to an
> fd has no budget, and that is a design error rather than a special case.** True trivially at M1
> (no event sources yet — the budget is a field and an errno), still true at M4 (pipes and the pty
> are fds) and at M7 (`win_create` returns an fd). If a future event source is not an fd, the move
> is to make it an fd, not to add a second budget taxonomy.
>
> *(web-os-builder's answer to a question I left open rather than guessed at. I had offered
> per-process or per-(process, source); both were wrong, and constraint 42 already contained the
> answer. To be confirmed against the dispatch code at M1.)*"""

s = open('MILESTONES.md').read()
if 'charged per fd' in s:
    print('  skip (already applied)')
else:
    assert old in s, 'anchor not found'
    open('MILESTONES.md', 'w').write(s.replace(old, new, 1))
    print('  ok   M1 (e): per-fd budget')

# PLAN 9b: the struck-through entry should point at the resolved spec
p = 'PLAN.md'
s = open(p).read()
o2 = """   mode that constraint 17's cap exists to prevent, with no cap on it. It wants the ABI contract,
   so it lands with M1's other table fields."""
n2 = """   mode that constraint 17's cap exists to prevent, with no cap on it. It wants the ABI contract,
   so it lands with M1's other table fields — **charged per fd**, because constraint 42 already made
   the fd the unit of wakeability and a budget charged against anything else disagrees with the wait
   primitive about what an event source is."""
if 'charged per fd' in s:
    print('  skip PLAN (already applied)')
else:
    assert o2 in s, 'PLAN anchor'
    open(p, 'w').write(s.replace(o2, n2, 1))
    print('  ok   PLAN 9b pointer')
