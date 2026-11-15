import json,os
F='/private/tmp/claude-503/-Users-chafyni-claude/e856c39e-d35f-4194-90b6-733ab8574dcd/tasks/wj5lvgyo5.output'
r=json.load(open(F))['result']
print("designs:",len(r['designs']),"confirmed:",len(r['confirmed']),"refuted:",r['refuted_count'])
for d in r['designs']:
    print("\n"+"="*72)
    print("NAME:",d['name'],"|",d['one_liner'])
    print("\nTHESIS:",d['thesis'])
    print("\nTHREAT MODEL:",d['threat_model'][:400])
    print("\nTOTAL EST DAYS:",d['total_est_days'])
    print("\nMILESTONES:")
    for m in d['milestones']:
        print("  %s. %s (%s d, ~%s LoC)"%(m['n'],m['title'],m['est_days'],m.get('est_loc','?')))
        print("     deliv:",m['deliverable'][:190])
    print("\nGIVES UP:")
    for x in d['what_it_gives_up']: print("  -",x[:230])
    print("\nKILL CRITERIA:")
    for x in d['kill_criteria']: print("  !",x[:230])
    print("\nRISKIEST:",d['riskiest_assumption'][:400])
