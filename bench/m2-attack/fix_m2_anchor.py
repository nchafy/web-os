"""Re-point mutate.py's m2_swing_before_flush anchor at the commit body as it now reads.

The mutation's INTENT is unchanged and so is what it breaks: the blob flush moves to AFTER the
journal's flush, so the record on disk points at data that is not durable. Only the anchor moved,
because the commit now validates in memory between the two steps — and the replacement keeps that
validation, so the mutation still isolates exactly one change.

The pre-fix anchor is kept as the first candidate, so the same mutate.py still applies to a tree
that predates the reordering.
"""
import pathlib

STORE = pathlib.Path(
    "/Users/chafyni/claude/web-os/.claude/worktrees/webos-impl/src/kernel/store.mjs")
MUTATE = pathlib.Path("/Users/chafyni/.claude/jobs/e856c39e/tmp/mutate.py")

store = STORE.read_text(encoding="utf-8")
start = store.index("    // 1. the blob, 2. its flush. Durable BEFORE anything points at it.\n")
end = store.index("    if (jflush < 0) return jflush;\n", start) + len(
    "    if (jflush < 0) return jflush;\n")
anchor = store[start:end]
assert store.count(anchor) == 1, store.count(anchor)
assert "applyOp" in anchor and "flushJournal" in anchor, anchor

blob_flush = ("    if (!this.cfg.noCowOrder) {\n"
              "      const flushed = await this.io.request(IO_FSYNC, { id: blobId });\n"
              "      if (flushed < 0) return flushed;\n"
              "      this.stats.blobFlushes += 1;\n"
              "    }\n")
assert anchor.startswith(
    "    // 1. the blob, 2. its flush. Durable BEFORE anything points at it.\n" + blob_flush)
rest = anchor.split(blob_flush, 1)[1]
replacement = ("    // MUTATION: validate, journal, journal flush, and only THEN flush the blob,\n"
               "    // so the record on disk points at data that is not durable.\n"
               + rest.lstrip("\n") + blob_flush)

text = MUTATE.read_text(encoding="utf-8")
needle = '    "m2_swing_before_flush": [('
i = text.index(needle)
j = text.index("    )],", i) + len("    )],")
old_entry = text[i:j]
assert old_entry.count("src/kernel/store.mjs") == 1, old_entry

new_entry = (
    old_entry[:-len("    )],")]
    + "    ), (\n"
      "        # The commit body as it reads now: the in-memory validation sits between the two\n"
      "        # flushes, and the replacement leaves it exactly where it is.\n"
      "        \"src/kernel/store.mjs\",\n"
      "        %r,\n"
      "        %r,\n"
      "    )],") % (anchor, replacement)

MUTATE.write_text(text.replace(old_entry, new_entry), encoding="utf-8")
print("mutate.py: m2_swing_before_flush now carries %d candidate anchors" % 2)
