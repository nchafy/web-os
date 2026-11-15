import json
import sys

CLAUSES = ('bothOpened', 'pendingHeldBack', 'stagedNewGeneration', 'committedBytesIntact',
           'bothKept', 'refusalLeftNoRecord', 'mountsReadWrite')
CHECK = ('ok', 'size', 'wantSize', 'prefixOk', 'bRangeOk', 'aTailOk', 'gapZeroed', 'pendingOk',
         'atS', 'atGap', 'atPend')

for path in sys.argv[1:]:
    print("=== %s ===" % path)
    d = json.load(open(path))
    for n in ('proof_a', 'proof_b', 'proof_c', 'proof_d', 'pending', 'refuse', 'order', 'api'):
        p = d.get(n)
        print("  %-8s %s" % (n, 'ok' if p and p['ok'] else 'FAIL'))
    e = (d.get('pending') or {}).get('evidence') or {}
    print("  clauses %s" % json.dumps({k: e.get(k) for k in CLAUSES}))
    print("  pend    %s" % json.dumps(e.get('pend')))
    print("  peek    %s" % json.dumps(e.get('peek')))
    print("  copyUps %s  blobsAfter %s" % (e.get('copyUps'), e.get('blobsAfter')))
    c = e.get('check') or {}
    print("  check   %s" % json.dumps({k: c.get(k) for k in CHECK}))
    print("  phase2  %s" % json.dumps(e.get('phase2')))
    print("  remount %s" % json.dumps(e.get('remount'))[:480])
    print("  dirAfter %s" % json.dumps(e.get('dirAfterRemount')))
    r = e.get('rereadAfterRemount') or {}
    print("  reread  %s" % json.dumps({k: r.get(k) for k in CHECK}))
