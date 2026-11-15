import json
d=json.load(open('/private/tmp/claude-503/-Users-chafyni-claude/e856c39e-d35f-4194-90b6-733ab8574dcd/tasks/wcgououxd.output'))
r=d['result']
print("RESULT TYPE:",type(r))
if isinstance(r,str):
    try: r=json.loads(r)
    except Exception as e: print("not json:",e); print(r[:500]); raise SystemExit
print("RESULT KEYS:",list(r.keys()) if isinstance(r,dict) else len(r))
for e in r.get('explored',[]):
    print("\n"+"="*72)
    print("TOPIC:",e.get('topic','?')[:200])
    print("\nSUMMARY:",e.get('summary',''))
    print("\n#findings:",len(e.get('findings',[])))
    print("REUSABLE:")
    for x in (e.get('reusable') or []): print("  -",x)
    print("GOTCHAS:")
    for x in (e.get('gotchas') or []): print("  !",x)
    print("UNKNOWN:")
    for x in (e.get('could_not_determine') or []): print("  ?",x)
print("\n"+"#"*72)
print("CRITIQUE:\n",r.get('critique',''))
