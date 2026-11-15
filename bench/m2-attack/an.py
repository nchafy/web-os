import collections

rows = []
for line in open('/Users/chafyni/.claude/jobs/e856c39e/tmp/procs2.txt'):
    p = line.split()
    if len(p) < 7:
        continue
    rows.append((float(p[0]), p[1], p[2], p[3], float(p[4]), p[5], p[6]))

profs = collections.OrderedDict()
for t, pid, ppid, ct, pc, ty, pr in rows:
    key = pr.split('showup-chrome-')[1][:12]
    profs.setdefault(key, {'first': t, 'last': t, 'pids': set()})
    profs[key]['last'] = t
    profs[key]['pids'].add((pid, ty))

t0 = min(r[0] for r in rows)
print("profiles seen (one temp profile per Browser()):")
for k, v in profs.items():
    print(f"  {k}: first {v['first']-t0:7.2f}s last {v['last']-t0:7.2f}s  procs {len(v['pids'])}")
ks = list(profs)
for a, b in zip(ks, ks[1:]):
    print(f"  overlap {a} -> {b}: {profs[a]['last']-profs[b]['first']:+.2f}s "
          f"(positive = both alive in the same sample window)")

by_t = collections.defaultdict(set)
for t, pid, ppid, ct, pc, ty, pr in rows:
    by_t[round(t, 2)].add(pr.split('showup-chrome-')[1][:12])
multi = [(t, s) for t, s in sorted(by_t.items()) if len(s) > 1]
print(f"\nsamples with more than one profile present: {len(multi)} of {len(by_t)}")
for t, s in multi[:10]:
    print(f"   t={t-t0:6.2f} {sorted(s)}")

print("\nper-sample process count and total %cpu, by profile:")
agg = collections.defaultdict(lambda: collections.defaultdict(lambda: [0, 0.0]))
for t, pid, ppid, ct, pc, ty, pr in rows:
    key = pr.split('showup-chrome-')[1][:12]
    a = agg[round(t, 2)][key]
    a[0] += 1
    a[1] += pc
for t in sorted(agg):
    parts = " | ".join(f"{k} n={v[0]} cpu={v[1]:6.1f}%" for k, v in sorted(agg[t].items()))
    print(f"  t={t-t0:6.2f}  {parts}")
