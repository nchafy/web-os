"""Inject a kernel-shaped check into a scratch copy of check.py, to test B1 both directions.

Direction (a): the check DECLARES that its measurement does not exist without cross-origin
isolation. --prove-failure must stay green.
Direction (b): the same check, equally unmeasurable, declares FAIL instead. The gate must fail,
because an undeclared BROKEN is a stray (the hole FIX 2 closed).
"""
import pathlib
import sys

SCRATCH = pathlib.Path(sys.argv[1])
DECLARED = sys.argv[2]  # "UNMEASURABLE" or "Outcome.FAIL"

INJECT = '''

# ---- B1 TEST INJECTION: a kernel-shaped check, as M0's will be ----
CHAN_SHAPE = {"sab": bool, "length": int}
CHAN_READ = """({
  sab: typeof SharedArrayBuffer === 'function',
  length: (typeof SharedArrayBuffer === 'function')
            ? new Int32Array(new SharedArrayBuffer(8)).length : -1,
})"""


@check(
    name="chan",
    milestone="M0",
    controls=(Control.INVERT, Control.NO_ISOLATION),
    min_expectations=1,
    requires_isolation=True,
)
def check_chan(env):
    got = env.read(CHAN_READ, CHAN_SHAPE)
    if not got["sab"]:
        env.unmeasurable(
            "SharedArrayBuffer is not constructible without cross-origin isolation, so the "
            "syscall channel has no measurement here")
    env.expect("sab i32 length", got["length"], 2)


CONTROLS["no-isolation"].expects["chan"] = Expect(
    __DECLARED__, why="a SAB is not constructible without COOP/COEP")
'''

path = SCRATCH / "scripts" / "check.py"
src = path.read_text()
marker = "\nif __name__ =="
assert marker in src, "no main guard found"
i = src.rindex(marker)
path.write_text(src[:i] + INJECT.replace("__DECLARED__", DECLARED) + src[i:])

floors = SCRATCH / "scripts" / "check_floors.json"
floors.write_text('{\n  "boot": 30,\n  "chan": 1\n}\n')

print("injected with declared outcome:", DECLARED)
