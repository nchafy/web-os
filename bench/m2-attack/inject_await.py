"""Make one real src/fs/ parse path async, to show the purity lint catches it."""
import pathlib
import sys

p = pathlib.Path(sys.argv[1]) / "src" / "fs" / "journal.mjs"
t = p.read_text()
old = "export function decodeRecord("
assert t.count(old) == 1, t.count(old)
p.write_text(t.replace(old, "export async function decodeRecord("))
print("injected: src/fs/journal.mjs decodeRecord is now `async`")
