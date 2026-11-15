import json
r=json.load(open('/private/tmp/claude-503/-Users-chafyni-claude/e856c39e-d35f-4194-90b6-733ab8574dcd/tasks/wj5lvgyo5.output'))['result']
L=['# Verified review findings','','Findings raised by 11 critics against four candidate architectures, each then put to an',
'adversarial verifier whose default was `refuted = true`. %d of %d survived; %d were refuted.'%(len(r['confirmed']),len(r['confirmed'])+r['refuted_count'],r['refuted_count']),'',
'Severity is the verifier\'s corrected severity, not the critic\'s claim. "Applies to all designs"',
'marks a finding the verifier judged to be a property of any design in this space, not of the one',
'it was raised against — those are the ones that became constraints.','']
order={'fatal':0,'major':1,'minor':2}
for i,c in enumerate(sorted(r['confirmed'],key=lambda x:(order.get(x['verdict']['corrected_severity'],9),x['design'])),1):
    f,v=c['finding'],c['verdict']
    L+=['## %d. %s'%(i,f['claim']),'',
        '- Severity: **%s** (confidence %s)%s'%(v['corrected_severity'],v['confidence'],'  —  **applies to every design**' if v.get('applies_to_all_designs') else ''),
        '- Raised against: `%s`'%c['design'],'- Address: %s'%f['address'],'',
        '**Failure scenario.** %s'%f['failure_scenario'],'']
    if f.get('fix_if_any'): L+=['**Fix.** %s'%f['fix_if_any'],'']
    L+=['**Verifier.** %s'%v['reasoning'],'']
    if v.get('evidence_url'): L+=['Evidence: %s'%v['evidence_url'],'']
open('/Users/chafyni/claude/my-web-os/designs/REVIEW-FINDINGS.md','w').write('\n'.join(L))
print('wrote',len(L),'lines')
