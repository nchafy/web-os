import sys

sys.path.insert(0, "/Users/chafyni/claude/web-os/.claude/worktrees/webos-impl/bench/syscall-contention")
import probe  # noqa: E402

measured = {"n": 16, "p99": {"us": 210.0}, "verdict": "ACCEPT",
            "why": "p99 210.0 us + 1 quantum < 500 us"}
unmeasur = {"n": 16, "p99": {"us": None, "why": "withheld"}, "verdict": "NO VERDICT",
            "why": "the p99 is not printable: withheld"}
slower = {"n": 16, "p99": {"us": 480.0}, "verdict": "ACCEPT",
          "why": "p99 480.0 us + 1 quantum < 500 us"}


def old(c):
    return c["p99"]["us"] or 0


print("N2 BEFORE  key(unmeasurable) =", old(unmeasur), "key(210us) =", old(measured),
      "-> worst run picked:", max([measured, unmeasur], key=old)["verdict"])
print("N2 AFTER   key(unmeasurable) =", probe.worst_rank(unmeasur),
      "key(210us) =", probe.worst_rank(measured),
      "-> worst run picked:", max([measured, unmeasur], key=probe.worst_rank)["verdict"])
print("N2 AFTER   two measured runs still rank by p99:",
      max([measured, slower], key=probe.worst_rank)["p99"]["us"], "us")
print()
print("N3 AFTER  all survived:", probe.across_runs_line([measured, slower], 2, 16).strip())
print("N3 AFTER  one lost   :", probe.across_runs_line([measured], 3, 16).strip())
