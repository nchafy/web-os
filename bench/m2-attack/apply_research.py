#!/usr/bin/env python3
"""Apply the hobbyist-OS survey's order-changing findings to MILESTONES.md and CLAUDE.md."""
import sys

def patch(path, old, new, label, marker=None):
    s = open(path).read()
    if marker and marker in s:
        print(f"  skip (already applied) {label}")
        return
    assert old in s, f"anchor not found: {label}"
    open(path, 'w').write(s.replace(old, new, 1))
    print(f"  ok   {label}")

M = 'MILESTONES.md'

# ---- 1. M1 gains four things that are cheaper now than later ----
patch(M,
"""## M1 — Process lifecycle, signals, hard cap · 4 days · ~1100 LoC""",
"""## M1 — Process lifecycle, signals, hard cap · 4 days · ~1100 LoC

> **Four additions from `docs/research/09-hobbyist-os-actions.md`, all because the process-table
> layout is set here and reworking it later is the expensive version.** Sources are in that file;
> each is a dependency, not a preference.
>
> **(a) The capability bitmask goes in the table now, even though the narrowing call lands at M6.**
> Otherwise M6 reworks the table. The credential already carries `caps` with nothing reading it.
> SerenityOS's shape: a service acquires its handles, then drops the promise that would let it
> acquire more — kernel state, checked at dispatch, and **monotonic**. The asserted invariant is
> monotonicity, not a symptom: after narrowing, every widening must fail.
>
> **(b) `sid` goes in the table now**, because M4's line discipline hangs SIGTTIN, SIGTTOU and
> SIGHUP off the session. The ABI has `setpgid` and no session concept at all, so M4 would
> otherwise have to add a field to a live table.
>
> **(c) `waitpid` must distinguish "exited with code N" from "killed for reason R".** With
> `Worker.terminate()` as the only kill and no exit path in the dying worker, **the kernel is the
> only thing that can record why** — so it is written at teardown or it is lost forever.
>
> **(d) Teardown is two-phase**: answer every outstanding call with a defined errno, then assert
> the count is zero. HelenOS's `EHANGUP` cleanup. Cheap here, and it is the only point where the
> outstanding-call count is still knowable.
>
> One thing deliberately *not* added: the "not responding" detector. It depends on nothing in the
> window half — it is a kernel-side timer plus a UI hook — and with no preemption a wedged app is
> the normal case. But there is no UI to hook until M4a, so it lands there. Noted so it is not
> discovered at M9.""",
"M1 header note", marker="Four additions from")

# ---- 2. Harness before M2 ----
patch(M,
"""## M2 — VFS core on OPFS · 8 days · ~1400 LoC""",
"""## M2a — A host-runnable kernel, before M2 · 1 day

Ordering finding, not a preference: this is cheaper before M2 than after it.

The inode table, the superblock and journal codecs, path resolution and the dispatch table should
run in **plain Node** — no Worker, no SAB, no OPFS. SerenityOS builds its libraries a second time
for the host ("Lagom") precisely so unit tests and 81 fuzz targets run in milliseconds while the
OS target gets only UBSAN.

The reason it must precede M2: **journal replay is a parser over torn bytes, which is exactly a
fuzz target.** M2's negative control tests *one* hand-truncated journal. A fuzzer tests ten
thousand, and finds the tear that the one hand-written case does not.

Costs no dependency and no build step — the same `.mjs` files, imported by a script. This is why
`src/abi.mjs` holding only integers and pure codecs matters: it is importable from Node.

**Proof.** The journal codec round-trips under Node; a fuzz run over truncated and bit-flipped
journals terminates with no crash and no silent acceptance of a bad record.
**Negative control.** Remove the CRC check — the fuzzer must immediately find an accepted bad
record.

---

## M2 — VFS core on OPFS · 8 days · ~1400 LoC""",
"M2a host-runnable kernel", marker="host-runnable kernel, before M2")

# ---- 3. M2 data consistency ----
patch(M,
"""**Proof.** (a) 10k files, reload, every byte and every mode bit intact; (b) truncate the journal""",
"""**Decide the data-consistency question in days 5-8.** File data is **not journalled — only
metadata is.** Blobs live flat in OPFS named by inode (26), so overwriting an existing file
mutates its blob *in place*. The journal and the alternating superblocks give consistency for
metadata; a blob half-overwritten when the tab dies leaves **intact metadata pointing at torn
data**. M2's ordering protects *new* data and does not make an overwrite atomic.

That is POSIX-permissible without `fsync`, and it is exactly ext4's `data=writeback` — which is
not ext4's default, precisely to avoid it. Phantom, the only shipped orthogonally-persistent OS,
gives every page three blocks under the rule "if a page is to be written, it goes to curr ONLY".

Two acceptable answers, and the choice must be made here rather than discovered later:
1. **Copy-on-write the blob** — write a new one, swing the reference at commit. Cheap, because the
   name is just an integer.
2. **Declare the guarantee metadata-only**, in `docs/CONSTRAINTS.md` and wherever a reader meets
   it.

Discovering this after a user has files is the bad outcome. `docs/research/09-hobbyist-os-actions.md` §5.

**Also decide the superblock's version field here**, because it is unavailable later: a generation
counter plus major/minor, with "minor newer than me ⇒ refuse". Phantom holds three superblock
copies, not two — against two alternating slots, a bad write to the older slot *during* a commit
can leave zero valid copies. With three, constraint 28's "mounts read-only and reports" can become
"mounts the previous generation read-write and reports" for the same honesty.

**Proof.** (a) 10k files, reload, every byte and every mode bit intact; (b) truncate the journal""",
"M2 data consistency", marker="Decide the data-consistency question")

# ---- 4. M8 -> M12 dependency reversal ----
patch(M,
"""## The window half (option A) — M7 to M14""",
"""## Ordering corrections in the window half

Two from `docs/research/09-hobbyist-os-actions.md`, both of which reverse or tighten what
`PLAN.md` §5 currently implies.

**M8 gates M12, not the other way round.** The blur governor cannot account what it did not
allocate. So the surface-ownership decision — kernel-allocated retained surfaces versus M8's
transferred `OffscreenCanvas` — has to be made *before* the governor, because only
server-allocated surfaces give **accounting and revocation**, which constraint 49's admission
controller and constraint 17's cap both need and neither currently has.

A transfer is also one-way and one-shot: the process loses the object, so there is **no front/back
pair and no cheap flip**. Haiku's server allocates bitmap memory and maps it to the client;
SerenityOS has the client allocate both stores and hand over an fd with a monotonic serial, so a
steady-state flip re-sends a known serial and the server maps nothing. The two mature systems chose
opposite sides — so decide it on this project's terms, and those terms favour server-allocated.
Recorded as proposed **D17**.

**M7 is missing two things the window fd will have to express**, and both are cheaper before M9 and
M10 are built on top:
1. **The destroy cascade.** Destroying a parent destroys its children, so closing one fd must be
   reported as closing *several*. SerenityOS's `destroy_window` returns the list of ids destroyed.
   M7 has no such event, so the process's fd table silently desynchronises from the kernel's.
2. **Cross-process ownership.** A picker broker must be able to parent its dialog onto the
   *requesting app's* window — that is the whole point of a broker — and M9's owner chain has no
   way to name a window in another process.

Also: M9's `modal ∈ {none, window, app, system}` describes *scope*, where SerenityOS's enforced
`WindowMode` describes *behaviour* — `Modeless | Passive | RenderAbove | Blocking`, with the blocker
computed by walking the chain. Those are different axes and an owned window needs both.

---

## The window half (option A) — M7 to M14""",
"window-half ordering", marker="Ordering corrections in the window half")

print("MILESTONES.md done")

# ---- 5. CLAUDE.md: the taskbar claim is false ----
C = 'CLAUDE.md'
patch(C,
"""- **The shell is a userland client of the same ABI.** Explorer, the taskbar and the window manager
  use the same syscalls as a third-party app. If the shell needs a privilege it cannot express as
  a capability it was granted, the boundary is fiction. (3 in `PLAN.md` §4)""",
"""- **The shell is a userland client of the same ABI — with one stated exception.** Explorer and the
  window manager use the same syscalls as a third-party app, and if they need a privilege they
  cannot express as a capability they were granted, the boundary is fiction.
  **The taskbar is the exception, and the earlier blanket claim was false.** It needs cross-process
  window enumeration that no ordinary client may have, and a per-process window fd cannot name
  another process's window. SerenityOS gives its taskbar a *second* endpoint on a separate socket
  with an event mask and `(client_id, window_id)` identity pairs the ordinary endpoint cannot
  enumerate. So the honest form of the invariant is **a second, separately-gated management
  interface** — still a capability the kernel granted, so the boundary survives, but it is not the
  same interface. (`docs/research/09-hobbyist-os-actions.md` §4)""",
"CLAUDE.md taskbar correction", marker="The taskbar is the exception")

print("CLAUDE.md done")
