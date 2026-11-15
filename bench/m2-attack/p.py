import json
r=json.load(open('/private/tmp/claude-503/-Users-chafyni-claude/e856c39e-d35f-4194-90b6-733ab8574dcd/tasks/wier45q0i.output'))['result']
print("confirmed:",len(r['confirmed']),"refuted:",r['refuted_count'],"minors:",len(r['minors']))
for c in r['confirmed']:
    print("\n--- [%s / %s] %s"%(c['lens'],c['verdict']['corrected_severity'],c['finding']['claim'][:230]))
    print("   FIX:",(c['finding'].get('fix') or '-')[:300])
print("\n"+"#"*60+"\nMINORS:")
for m in r['minors']: print(" -",m['f']['claim'][:180])
print("\n"+"#"*60+"\nHOLDS UP:")
for h in r['holds_up']: print(" +",h[:600],"\n")
