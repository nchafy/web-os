#!/usr/bin/env python3
"""Print every expectation label a check recorded, and which did not hold, for one control run.

Wraps the scratch tree's own check.py; it never edits it.
"""
import sys

TREE = sys.argv[1]
sys.path.insert(0, TREE + "/scripts")
import check  # noqa: E402

_orig = check.Report.add


def add(self, result):
    _orig(self, result)
    print("LABELS %s %d: %s" % (result.check.name, len(result.labels), result.labels))
    print("FAILED %s %d: %s" % (result.check.name, len(result.failed_labels),
                                result.failed_labels))


check.Report.add = add
sys.exit(check.main(sys.argv[2:]))
