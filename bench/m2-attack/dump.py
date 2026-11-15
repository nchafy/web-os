import json,os,re
OUT='/Users/chafyni/claude/my-web-os/research'
d=json.load(open('/private/tmp/claude-503/-Users-chafyni-claude/e856c39e-d35f-4194-90b6-733ab8574dcd/tasks/wcgououxd.output'))
r=d['result']
slug=lambda s: re.sub(r'[^a-z0-9]+','-',s.lower()).strip('-')[:40]
names=[]
for e in r['explored']:
    t=e['topic'].split('—')[0].split(':')[0].strip()
    fn=os.path.join(OUT,'explore-'+slug(t)+'.md')
    with open(fn,'w') as f:
        f.write('# '+e['topic']+'\n\n## Summary\n\n'+e['summary']+'\n\n## Findings\n\n')
        for c in e.get('findings',[]):
            f.write('### '+c['claim']+'\n\n- Evidence: '+c['evidence_url']+'\n- Confidence: '+c['confidence']+'\n- Why it matters: '+c.get('why_it_matters','')+'\n\n')
        for key,hdr in (('reusable','Reusable'),('gotchas','Gotchas'),('could_not_determine','Could not determine')):
            v=e.get(key) or []
            if v:
                f.write('## '+hdr+'\n\n')
                for x in v: f.write('- '+x+'\n')
                f.write('\n')
    names.append((os.path.basename(fn),len(e.get('findings',[]))))
with open(os.path.join(OUT,'completeness-critique.md'),'w') as f:
    f.write('# Completeness critique of the exploration round\n\n'+r['critique']+'\n')
for n,c in names: print(n, c, 'findings')
print('completeness-critique.md')
