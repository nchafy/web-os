import json
import sys

JUNK = ('clock', 'envKeys', 'abiFingerprint', 'isolated', 'exiting', 'sinkSum', 'sinkBytes',
        'sinkWrites', 'calls', 'replies', 'ms', 'pid', 'errors', 'mode', 'arg')


def clean(a):
    a = dict(a)
    for j in JUNK:
        a.pop(j, None)
    return a


for path in sys.argv[1:]:
    print("=== %s ===" % path)
    d = json.load(open(path))
    p = d.get('proof_a')
    if not p:
        print("  no proof_a")
        continue
    e = p['evidence']
    flags = {k: e[k] for k in e if k.endswith('Ok')}
    print("  ok=%s FLAGS %s" % (p['ok'], json.dumps(flags)))
    for k, v in e.items():
        if k in flags:
            continue
        if isinstance(v, dict) and 'attack' in v:
            print("  %s %s" % (k, json.dumps(clean(v['attack']))))
            for extra in ('copyUps', 'blobsAfter', 'remount'):
                if extra in v:
                    print("      %s %s" % (extra, json.dumps(v[extra])[:500]))
        elif k == 'grown':
            print("  grown %s" % json.dumps(clean(v)))
        elif k in ('injected', 'blobsBefore', 'blobsAfter', 'fsck', 'remountMode',
                   'remountProblems', 'path'):
            print("  %s %s" % (k, json.dumps(v)[:300]))
