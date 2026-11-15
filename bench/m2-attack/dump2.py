import json,os,re
OUT='/Users/chafyni/claude/my-web-os/research'
d=json.load(open('/private/tmp/claude-503/-Users-chafyni-claude/e856c39e-d35f-4194-90b6-733ab8574dcd/tasks/we4fyy9kc.output'))
r=d['result']
print("failed:",r.get('failed'))
order=['agent cluster','Browsix','syscall','benchmark','Deployab','VFS']
for i,g in enumerate(r['gaps']):
    fn=os.path.join(OUT,'gap-%02d.md'%(i+1))
    with open(fn,'w') as f:
        f.write('# '+g['gap']+'\n\n## Verdict\n\n'+g['verdict']+'\n\n## Detail\n\n'+g['detail']+'\n\n## Claims\n\n')
        for c in g.get('claims',[]):
            f.write('- ['+c['confidence']+'] '+c['claim']+'\n  - '+c['evidence_url']+'\n')
        for k,h in (('design_consequences','Design consequences'),('could_not_determine','Could not determine')):
            v=g.get(k) or []
            if v:
                f.write('\n## '+h+'\n\n')
                for x in v: f.write('- '+x+'\n')
    print(os.path.basename(fn), len(g.get('claims',[])),'claims', len(g.get('detail','')),'chars detail')
