# M2's attack corpus, preserved

The scripts from the eight verification rounds that M2's VFS went through, copied verbatim out of
a job-scoped scratch directory that no longer survives. 194 files, 1.2 MB. The 2.8 GB of run
output they produced was left behind: the scripts are the reusable part, the logs were evidence
for findings that are now recorded in `docs/CONSTRAINTS.md` 61–71.

**These are evidence, not a gate.** Nothing runs them automatically, they were written against the
tree as it stood during M2, and several are one-shot probes whose anchors have since moved. They
are here because re-running one is the cheapest check that a change did not reopen something M2
closed, and because writing them again from the findings would cost more than keeping them.

The committed gates are `scripts/check.py`, `scripts/fsfuzz.py` and `scripts/check_links.py`.
Those are what must pass.

## What is in here

| Pattern | What it is |
| --- | --- |
| `vattack*.py` | the per-round VFS attacks; the numeric suffix is roughly the round |
| `judge*.py`, `atk*.sh`, `run7.sh`, `sweep.sh`, `final*.sh` | round drivers and verdict collators |
| `mutate.py`, `mutate_neg.py`, `inject_*.py`, `f9inject*.py`, `erode_patch.py`, `crash_patch.py` | mutation harnesses — they patch `src/`, run a gate, and restore |
| `edge*`, `d3.py`–`d5.py`, `gap6.py`, `errno20.py` | single-finding probes |

**The mutation harnesses patch files in `src/` in place.** They restore on the way out, but a
killed run leaves the tree patched. Check `git status` before trusting a result from one.
