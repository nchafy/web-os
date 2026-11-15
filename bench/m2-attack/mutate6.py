#!/usr/bin/env python3
"""Round 6's negative controls: undo one fix in a scratch copy and see the new clause fire.

mutate6.py <name>   — patches ${TMP}/mut/<name>/, which sweep6.sh has just rsynced.

Each mutation restores EXACTLY the state the fix changed, so a clause that still passes is a
clause not coupled to its subject. Unlike mutate.py's seven, a mutation here may carry several
edits and ALL of them must apply: m8a is the C1 defect plus the removal of the invariant that
catches it, and either half alone is a different experiment.
"""
import pathlib
import sys

ROOT = pathlib.Path("/Users/chafyni/.claude/jobs/e856c39e/tmp/mut")

SEQ_AFTER_AWAIT = (
    "src/kernel/store.mjs",
    "    const seq = this.seq;\n"
    "    this.seq = seq + 1n;\n"
    "    const record = encodeRecord(seq, payload);\n"
    "    const n = await this.io.request(IO_JOURNAL, { op: \"append\", bytes: copyOut(record) });\n"
    "    if (n < 0) return n;\n",
    "    const seq = this.seq;\n"
    "    const record = encodeRecord(seq, payload);\n"
    "    const n = await this.io.request(IO_JOURNAL, { op: \"append\", bytes: copyOut(record) });\n"
    "    if (n < 0) return n;\n"
    "    // MUTATION: the sequence is allocated ACROSS the await again.\n"
    "    this.seq = seq + 1n;\n",
)

INVARIANT_REMOVED = (
    "src/kernel/iocore.mjs",
    "        if (r.seq !== journalSeq) {\n"
    "          note(`journal record ${r.seq} was appended where ${journalSeq} was expected: a `\n"
    "            + \"sequence that is not strictly consecutive makes replay discard the tail\");\n"
    "          return -EIO;\n"
    "        }\n",
    "        // MUTATION: the writer-side invariant removed, so a duplicate reaches the disk.\n",
)

MUTATIONS = {
    # C1, as it was: the sequence allocated after the await AND no writer-side invariant. The
    # duplicate reaches the disk and the next mount discards the tail.
    "m8a_seq_after_await": [SEQ_AFTER_AWAIT, INVARIANT_REMOVED],
    # C1's bug with the invariant KEPT. The duplicate must now fail at the append instead of at
    # the next mount, which is a different clause failing and the invariant's whole purpose.
    "m8b_seq_after_await_guarded": [SEQ_AFTER_AWAIT],
    # THE DUPLICATE SEQUENCE AS A STATE RATHER THAN AS A RACE. m8a and m8b restore the defect that
    # PRODUCES it and the race did not reproduce in this tree, so they prove nothing either way;
    # these two inject the state itself — every tenth record carries its predecessor's number —
    # which is what the clause is about. Guarded, it must fail at the append; unguarded, the
    # duplicate reaches the disk and the next mount discards the tail.
    "m12_dup_seq_guarded": [(
        "src/kernel/store.mjs",
        "    const seq = this.seq;\n"
        "    this.seq = seq + 1n;\n"
        "    const record = encodeRecord(seq, payload);\n",
        "    const seq = this.seq;\n"
        "    this.seq = seq + 1n;\n"
        "    // MUTATION: every tenth record carries its predecessor's number.\n"
        "    const record = encodeRecord(seq > 0n && seq % 10n === 0n ? seq - 1n : seq, payload);\n",
    )],
    "m12b_dup_seq_unguarded": [(
        "src/kernel/store.mjs",
        "    const seq = this.seq;\n"
        "    this.seq = seq + 1n;\n"
        "    const record = encodeRecord(seq, payload);\n",
        "    const seq = this.seq;\n"
        "    this.seq = seq + 1n;\n"
        "    // MUTATION: every tenth record carries its predecessor's number.\n"
        "    const record = encodeRecord(seq > 0n && seq % 10n === 0n ? seq - 1n : seq, payload);\n",
    ), INVARIANT_REMOVED],
    # C2, as it was: the stamp is `(gen, end)` again — the generation and the extent, which an
    # in-place write inside the slack moves neither of.
    "m9_stamp_gen_end": [(
        "src/kernel/store.mjs",
        "function moved(base, now) {\n  return base.mut !== now.mut;\n}",
        "function moved(base, now) {\n"
        "  // MUTATION: the stamp is the generation and the extent again.\n"
        "  return base.gen !== now.gen || base.end !== now.end;\n}",
    ), (
        "src/kernel/store.mjs",
        "    const base = staging ? { mut: d.baseMut } : { mut: at.mut };",
        "    const base = staging ? { gen: d.baseGen, end: d.baseEnd }\n"
        "      : { gen: at.gen, end: at.end };",
    ), (
        "src/kernel/store.mjs",
        "    d.baseMut = live.mut;\n    d.baseEnd = live.end;",
        "    d.baseGen = live.gen;\n    d.baseMut = live.mut;\n    d.baseEnd = live.end;",
    ), (
        "src/kernel/store.mjs",
        "        d.baseMut = live.mut;\n        d.baseEnd = live.end;",
        "        d.baseGen = live.gen;\n        d.baseMut = live.mut;\n        d.baseEnd = live.end;",
    ), (
        "src/kernel/store.mjs",
        "      d.baseMut = live.mut;\n      d.baseEnd = live.end;",
        "      d.baseGen = live.gen;\n      d.baseMut = live.mut;\n      d.baseEnd = live.end;",
    )],
    # The same blind spot reached from the other side: the counter bumped only when the extent
    # moves. It SURVIVED, because `commitOnce`'s own bump stands in for the missing one — which is
    # why the faithful mutation above is the control and this one is kept as the record of that.
    "m9_slack_blind": [(
        "src/kernel/store.mjs",
        "      const row = this.held.get(d.ino);\n"
        "      if (row) {\n"
        "        if (from + n > row.end) row.end = from + n;\n"
        "        row.mut += 1;\n"
        "      }\n",
        "      const row = this.held.get(d.ino);\n"
        "      if (row) {\n"
        "        // MUTATION: bumped only when the extent moves.\n"
        "        if (from + n > row.end) { row.end = from + n; row.mut += 1; }\n"
        "      }\n",
    )],
    # C3, as it was: the exhaustion arm frees the stage, so the caller's retry answers 0 over
    # data that is gone.
    "m10_ebusy_drops_stage": [(
        "src/kernel/store.mjs",
        "          + \"staged generation is kept, so a retry can still publish it\");\n"
        "        return -EBUSY;\n",
        "          + \"staged generation is kept, so a retry can still publish it\");\n"
        "        // MUTATION: the stage is discarded, so the retry takes the nothing-to-publish arm.\n"
        "        if (d.dirtyGen) await this.dropStaging(d);\n"
        "        return -EBUSY;\n",
    )],
    # C4, as it was: `read` clamps to the base its copy came FROM while `fstat` and `SEEK_END`
    # read the extent now, so one description's own answers disagree.
    "m11_read_base_clamp": [(
        "src/kernel/store.mjs",
        "    const id = reach.id;\n"
        "    const want = Math.min(length, Math.max(0, reach.end - from));\n",
        "    const id = reach.id;\n"
        "    // MUTATION: the read clamps to the base the copy came from, not to the live extent.\n"
        "    const readEnd = d.dirtyGen ? this.stagedEnd(d, d.baseEnd) : reach.end;\n"
        "    const want = Math.min(length, Math.max(0, readEnd - from));\n",
    )],
}


def main() -> int:
    name = sys.argv[1]
    edits = MUTATIONS[name]
    for rel, old, new in edits:
        path = ROOT / name / rel
        if not path.exists():
            print("MISSING %s" % path)
            return 1
        text = path.read_text()
        n = text.count(old)
        if n != 1:
            print("ANCHOR NOT UNIQUE in %s: %d occurrence(s)" % (rel, n))
            return 1
        path.write_text(text.replace(old, new))
        print("patched %s/%s" % (name, rel))
    return 0


if __name__ == "__main__":
    sys.exit(main())
