import json,textwrap
d=json.load(open('/private/tmp/claude-503/-Users-chafyni-claude/e856c39e-d35f-4194-90b6-733ab8574dcd/tasks/wcgououxd.output'))
r=d['result']
for e in r['explored']:
    print("="*72); print("TOPIC:",e['topic'].split('—')[0].strip()[:90])
    print(e['summary']); print()
print("#"*72); print("CRITIQUE:"); print(r['critique'])
