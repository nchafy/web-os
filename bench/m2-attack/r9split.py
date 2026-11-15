#!/usr/bin/env python3
"""Attribute the control tree's setup failure: which half of the F1 revert breaks it."""
import pathlib
import sys

sys.path.insert(0, "/Users/chafyni/.claude/jobs/e856c39e/tmp")
import vattack30pre as V  # noqa: E402

BASE = pathlib.Path("/Users/chafyni/.claude/jobs/e856c39e/tmp/mut")

V.ROOT = BASE / "revstore"
V.patch("src/kernel/store.mjs", V.STORE)
V.ROOT = BASE / "revcalls"
V.patch("src/kernel/calls.mjs", V.CALLS)
print("ok")
