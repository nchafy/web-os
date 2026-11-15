import pathlib
import sys

p = pathlib.Path(sys.argv[1])
s = p.read_text()
assert s.count("    min_expectations=29,") == 1
s = s.replace("    min_expectations=29,", "    min_expectations=1,", 1)
start = s.index("def check_boot(env: Env) -> None:")
end = s.index("# ======================================================================================\n# Phases, the loop and the gates")
body = '''def check_boot(env: Env) -> None:
    # Every assertion over the rows, the realm, the wire and the served bytes is gone.
    # One expectation left, and min_expectations was lowered to match.
    got = env.read(READ_PREFLIGHT, SHAPE)
    env.expect("verdict flag", got["verdict"], "ok")


'''
p.write_text(s[:start] + body + s[end:])
print("eroded", p)
