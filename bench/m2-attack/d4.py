import json
r=json.load(open('/private/tmp/claude-503/-Users-chafyni-claude/e856c39e-d35f-4194-90b6-733ab8574dcd/tasks/wj5lvgyo5.output'))['result']
for d in r['designs']:
    print("%-14s %3sd  %s"%(d['name'],d['total_est_days'],d['one_liner'][:120]))
    print("   RISK:",d['riskiest_assumption'][:260]); print()
print("#"*72)
print("CONFIRMED FINDINGS (%d of %d survived; %d refuted)\n"%(len(r['confirmed']),len(r['confirmed'])+r['refuted_count'],r['refuted_count']))
for c in r['confirmed']:
    v=c['verdict']
    print("[%s -> %s] %s"%(c['design'],v['corrected_severity'],c['finding']['claim'][:200]))
    print("    scenario:",c['finding']['failure_scenario'][:280])
    print("    all-designs:",v.get('applies_to_all_designs'),"conf:",v['confidence'])
    if c['finding'].get('fix_if_any'): print("    fix:",c['finding']['fix_if_any'][:200])
    print()
