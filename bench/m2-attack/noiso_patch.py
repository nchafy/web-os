import pathlib
import sys

p = pathlib.Path(sys.argv[1])
s = p.read_text()
old = "</body>"
assert s.count(old) == 1
# Fires only when the page is NOT cross-origin isolated, so the invert phase stays clean
# and only the --prove-failure no-isolation phase sees it.
inject = """<script>
if (!self.crossOriginIsolated) {
  fetch('/does-not-exist.json').catch(() => {})
  new SharedArrayBuffer(8)
}
</script>
</body>"""
p.write_text(s.replace(old, inject, 1))
print("noiso-patched", p)
