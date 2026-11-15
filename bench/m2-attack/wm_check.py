"""A milestone's checks, in the layout the design mandates (scripts/checks/<name>.py)."""

from check import Check, Control, Env, check  # noqa: F401


@check(
    name="wm-focus",
    milestone="m7",
    controls=(Control.INVERT, Control.NO_ISOLATION),
    min_expectations=1,
)
def check_wm_focus(env: Env) -> None:
    env.expect("this never runs", 1, 2)
