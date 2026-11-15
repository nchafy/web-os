import pathlib
import sys

p = pathlib.Path(sys.argv[1])
s = p.read_text()

# A plausible authoring slip: a key the page did not return.
old = '    env.expect("verdict flag", got["verdict"], "ok")'
assert s.count(old) == 1
s = s.replace(old, '    env.expect("verdict flag", got["verdictt"], "ok")', 1)

anchor = ("# ======================================================================================\n"
          "# Phases, the loop and the gates")
assert s.count(anchor) == 1
later = '''@check(
    name="later",
    milestone="m1",
    controls=(Control.INVERT, Control.NO_ISOLATION),
    min_expectations=1,
)
def check_later(env: Env) -> None:
    env.expect("runs at all", True, True)


'''
s = s.replace(anchor, later + anchor, 1)
s = s.replace('MODULES = ("boot",)', 'MODULES = ("boot", "later")', 1)
p.write_text(s)
print("crash-patched", p)
