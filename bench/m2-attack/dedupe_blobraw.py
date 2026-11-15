"""Drop vattack4.py's own writeBlobRaw: www/m2.html now carries it.

The page grew the same helper for its `orphan` section, so the attack's copy is a SECOND
declaration of one name in one module scope — a SyntaxError that left the page at state
'starting' and the probe reporting "never reached a terminal state" after 600 s. The attack now
calls the page's helper, which is also the only copy.
"""
import pathlib

p = pathlib.Path("/Users/chafyni/.claude/jobs/e856c39e/tmp/vattack4.py")
t = p.read_text()

OLD = '''/** Write a blob file directly, the way proof (b) writes a torn journal: the page is the only
 *  agent that can touch the volume while no kernel holds it. */
async function writeBlobRaw(name, bytes) {
  const root = await navigator.storage.getDirectory()
  const dir = await root.getDirectoryHandle(BLOB_DIR, { create: true })
  const fh = await dir.getFileHandle(name, { create: true })
  const w = await fh.createWritable()
  await w.truncate(0)
  await w.write(bytes)
  await w.close()
}

'''
NEW = '''/* writeBlobRaw comes from www/m2.html, which grew it for the same reason this attack needs it:
 * the page is the only agent that can touch the volume while no kernel holds it. A second
 * declaration of that name in one module scope is a SyntaxError and the page never boots. */

'''

assert t.count(OLD) == 1, t.count(OLD)
p.write_text(t.replace(OLD, NEW))
print("vattack4.py: duplicate writeBlobRaw removed")
