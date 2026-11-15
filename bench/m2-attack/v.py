import json
d=json.load(open('/private/tmp/claude-503/-Users-chafyni-claude/e856c39e-d35f-4194-90b6-733ab8574dcd/tasks/we4fyy9kc.output'))
for g in d['result']['gaps'][1:]:
    print("="*72); print("GAP:",g['gap'][:150]); print("\nVERDICT:",g['verdict'])
    print("\nCONSEQUENCES:")
    for x in (g.get('design_consequences') or []): print("  *",x)
    print("\nUNKNOWN:")
    for x in (g.get('could_not_determine') or []): print("  ?",x)
    print()
