#!/usr/bin/env python3
"""M19's advance probe: CAN A PUBLISHED ADVANCE TABLE LAY OUT A COLUMN?

    python3 bench/m19-advance/probe.py
    python3 bench/m19-advance/probe.py --headed          # a real Chrome window, for a human
    python3 bench/m19-advance/probe.py --prove-failure   # the clauses, shown capable of failing

M19 wants fitted columns: a file manager that sizes `Name` to the longest name it is showing and
right-aligns `Size` needs to know how wide a string will be BEFORE it draws it, and a process
cannot measure a font — it has no canvas, and `src/libos/lockdown.mjs` is why. The plan's answer is
a generated `/dev` row carrying per-family, per-size advance widths, published out of
`src/abi.mjs` (`docs/PLAN-SHELL.md` §2 M19). That table is a CONSTANT, and this project's own
finding is that a geometry derived from a measured rect survives a second engine while one derived
from a constant does not: M11 placed a blur band at a constant offset and M12 asserted a dpr-2
window count, and each cost a milestone with every expectation green (constraints 264, 297).

So this runs BEFORE any code is written against the table (`docs/PLAN-SHELL.md` §5), and it asks
three questions a design decision rests on:

**1. DOES ONE TABLE SERVE BOTH ENGINES AND BOTH RATIOS?** All 95 printable ASCII code points, in
each of the four variants a `DL_TEXT` op can ask for, at each declared size, in Chrome at dpr 1,
1.5 and 2 and in Firefox — the engine that renders at dpr 1 on this machine, which is where a
ratio-shaped error hides. Scored against the plan's own 0.5 px threshold.

**2. IS A COLUMN'S WIDTH THE SUM OF ITS CHARACTERS' ADVANCES?** A table can only be summed. If the
renderer kerns or shapes, `measureText(name)` is not the sum of the per-character advances a table
publishes, and a column fitted from one is wrong by the difference — on the strings that matter,
since `AV`, `To`, `Wa` and `f(` are the pairs a proportional font kerns.

**3. IS AN ADVANCE LINEAR IN THE SIZE?** If it is, the table needs one row per FAMILY and the size
is arithmetic. If it is not, it needs a row per size and a program drawing at an undeclared size
has none — which is the plan's stated design, and this says what that row count costs.

The size is in SURFACE px, which is the unit `DL_TEXT`'s `a2` already carries: `measureText` runs
in the canvas's own coordinate space, and that space is the backing store (`src/wm/surface.mjs`
`:189`, `Surface`'s constructor). The declared set below is derived from that, not chosen.

WHAT THIS DOES NOT ANSWER. A name outside printable ASCII. The table holds 95 rows by the plan's
own scope, so a name with a non-ASCII code point has no row for it and must fall back — the same
fallback an undeclared size takes. This probe does not price that fallback.

EXIT STATUS. 0 when every clause is green; 1 when any is red. On an unmodified tree
`kerning-proportional` IS red, and that is the finding rather than a malfunction — the run says so
in its own output. Under `--prove-failure` the status inverts its meaning: 0 means the proof
succeeded, which is `scripts/check.py`'s rule for the same flag.
"""
from __future__ import annotations

import argparse
import copy
import json
import math
import os
import pathlib
import re
import sys
import threading
import time

HERE = pathlib.Path(__file__).resolve().parent
REPO = HERE.parent.parent
sys.path.insert(0, str(REPO / "scripts"))

import bidi  # noqa: E402
import cdp  # noqa: E402
import serve  # noqa: E402

DOC = "/bench/m19-advance/advance.html"

#: The same flags `bench/m17-wheel/probe.py` uses headed, for the same reason: a headed run is for
#: a human watching and the suite is headless, so headless is the world a clause will run in.
HEADED_FLAGS = ("--force-color-profile=srgb", "--disable-lcd-text")

#: THE SIZES PROGRAMS DRAW AT TODAY, in CSS px: `src/bin/files.mjs:153` draws `TEXT_PX` and
#: `TEXT_PX - 1`, and `src/bin/taskmgr.mjs:85` draws `TEXT_PX + 1`, `TEXT_PX - 1` and `TEXT_PX - 2`.
#: A program's own layout constants are CSS px and `toSurface` rounds them (`files.mjs:246`), so
#: the surface-px set a table must hold is these times the ratios in use.
DECLARED_CSS = (10, 11, 12, 13)
RATIOS = (1.0, 1.5, 2.0)

#: THE DECLARED SET, DERIVED AND NOT CHOSEN: `Math.round(css * ratio)` over the grid above. This is
#: what `src/abi.mjs` would publish, and `src/wm/surface.mjs:189` accepting any positive i32 is why
#: the renderer cannot offer one of its own.
#:
#: `floor(x + 0.5)` AND NOT PYTHON'S `round`. `Math.round` is half-UP and Python's `round` is
#: half-to-EVEN, and the two disagree at exactly the case this grid produces: 11 CSS px at dpr 1.5
#: is 16.5, which `src/bin/files.mjs:246`'s `Math.round` makes 17 and `round` makes 16. A set built
#: the Python way would publish a row for a size no program draws at and have NO row for one that
#: two of them do — and the failure is silent, because an undeclared size falls back by design.
SIZES_DECLARED = tuple(sorted({int(math.floor(c * r + 0.5))
                               for c in DECLARED_CSS for r in RATIOS}))

#: MEASURED AS A CONTIGUOUS SUPERSET of the declared set, so the per-size figures below answer for
#: any set M19 lands on rather than only for the one derived today. A size in this range that is
#: not in `SIZES_DECLARED` is still reported; it is simply not owed a row.
SIZES_MEASURED = tuple(range(10, 27))

#: The plan's own threshold (`docs/PLAN-SHELL.md` §5). Half a pixel: below it a column fitted from
#: the table and one fitted from a measurement land on the same device pixel at dpr 2.
TOLERANCE_PX = 0.5

#: HOW FAR AN ADVANCE MAY MOVE WITH THE RATIO AND STILL COUNT AS NOT MOVING: one unit of the
#: page's own 1/10 000 px rounding, so the clause asserts EQUALITY and not a tolerance. A ratio
#: dependency of any size changes what the table must be indexed by, so there is no small one.
RATIO_EPSILON = 0.0001

#: ABOVE THIS, A DISAGREEING CODE POINT GETS ITS OWN LINE. It is a reporting cut and not a
#: threshold anything is scored against: a twentieth of a pixel is below what a layout can act on
#: at either ratio, so listing all 95 would bury the one code point that matters in 94 that do not.
REPORT_FLOOR_PX = 0.05

#: The world the table would be MEASURED IN if it were published today: Chrome at dpr 2 is the
#: reference machine's configuration, and every figure in `docs/CONSTRAINTS.md` names it.
REFERENCE = "chrome@dpr2"


# ---- the page ---------------------------------------------------------------------------------

def _await_ready(evaluate, deadline: float) -> bool:
    while time.time() < deadline:
        if evaluate("String(Boolean(globalThis.__ready))") == "true":
            return True
        time.sleep(0.1)
    return False


def _read(evaluate_json, sizes: tuple[int, ...]) -> dict:
    """One world's whole table, or a dict carrying `error`."""
    expr = "globalThis.__advance(%s)" % json.dumps(list(sizes))
    raw = evaluate_json(expr)
    if isinstance(raw, dict):
        return raw
    if isinstance(raw, str):
        try:
            return json.loads(raw)
        except json.JSONDecodeError as err:
            return {"error": "the page returned unparseable JSON: %s" % err}
    return {"error": "the page returned %r rather than a JSON string" % type(raw).__name__}


def measure_chrome(base: str, ratios: tuple[float, ...], headed: bool,
                   sizes: tuple[int, ...]) -> dict[str, dict]:
    worlds: dict[str, dict] = {}
    with cdp.Browser(extra_args=HEADED_FLAGS if headed else (), headless=not headed) as browser:
        page = browser.page()
        page.call("Runtime.enable")
        for dpr in ratios:
            name = "chrome@dpr%g" % dpr
            # THE RATIO IS SET AND THEN THE PAGE IS LOADED, which is `bench/m17-wheel/probe.py`'s
            # ordering and its reason: a canvas built at the previous ratio keeps it.
            page.emulate_device(width=1100, height=700, scale_factor=dpr, mobile=False)
            page.navigate(base + DOC, timeout=60)
            if not _await_ready(page.evaluate, time.time() + 30):
                worlds[name] = {"error": "the page never became ready"}
                continue
            worlds[name] = _read(
                lambda expr: page.evaluate(expr, await_promise=True), sizes)
            worlds[name].setdefault("askedDpr", dpr)
    return worlds


def measure_firefox(base: str, ratios: tuple[float, ...], headed: bool,
                    sizes: tuple[int, ...]) -> dict[str, dict]:
    """Firefox over `scripts/bidi.py`.

    THE RATIO IS ASKED FOR OVER `browsingContext.setViewport`, which `scripts/bidi.py` does not
    wrap — so it goes through the generic `call`, and whether the engine honoured it is READ BACK
    off `devicePixelRatio` rather than assumed. Firefox renders at dpr 1 on the reference machine
    (CLAUDE.md), so a ratio it refuses is a gap this reports instead of a figure it invents.
    """
    worlds: dict[str, dict] = {}
    with bidi.Firefox(headless=not headed, width=1100, height=700) as ff:
        for dpr in ratios:
            name = "firefox@dpr%g" % dpr
            asked = {"ok": True, "error": ""}
            try:
                ff.call("browsingContext.setViewport", {
                    "context": ff.ctx,
                    "viewport": {"width": 1100, "height": 700},
                    "devicePixelRatio": dpr,
                })
            except Exception as err:  # the engine may not implement the parameter
                asked = {"ok": False, "error": str(err)[:200]}
            ff.navigate(base + DOC)
            if not _await_ready(lambda expr: ff.evaluate(expr, raw=True), time.time() + 60):
                worlds[name] = {"error": "the page never became ready", "askedDpr": dpr}
                continue
            worlds[name] = _read(lambda expr: ff.evaluate(expr, raw=True), sizes)
            worlds[name].setdefault("askedDpr", dpr)
            worlds[name]["setViewport"] = asked
    return worlds


# ---- the injections ---------------------------------------------------------------------------

def injections(worlds: dict[str, dict]) -> list[dict]:
    """`--prove-failure`'s controls: one per clause, each with the clause it MAY move and no other.

    APPLIED ONE AT A TIME AND SCORED SEPARATELY, because an injection sweep that breaks everything
    at once proves only that the arithmetic runs — a control must move a NAMED subset or it
    verifies nothing (CLAUDE.md). They are applied to the collected tables rather than to the page:
    the subject of this probe is the comparison, and the comparison is what has to be shown capable
    of failing.

    `kerning-proportional` is absent on purpose. It is red on the unmodified tree, so there is
    nothing for an injection to demonstrate about it, and a control that cannot change an outcome
    must be reported rather than written.
    """
    size = str(SIZES_DECLARED[0])
    ref_engine = REFERENCE.split("@", 1)[0]
    live = [n for n in worlds if "adv" in worlds[n]]
    others = [n for n in live if not n.startswith(ref_engine)]
    same = [n for n in live if n.startswith(ref_engine)]
    out: list[dict] = []

    if others:
        # THE SAME CELL IN EVERY WORLD OF THE OTHER ENGINE, so the two engines disagree by 1 px
        # while neither disagrees with itself. One world alone would move `ratio-independence` too.
        def cross(w, _names=tuple(others)):
            for n in _names:
                row = w[n]["adv"]["ui"][size]
                row[0] = round(row[0] + 1.0, 4)
        out.append({"clause": "cross-world", "apply": cross,
                    "what": "ui %spx U+0020 widened by 1.0 px in every %s world (%s)"
                            % (size, others[0].split("@", 1)[0], ", ".join(others))})

    if len(same) > 1:
        # 0.3 px INTO ONE RATIO of the reference engine: deliberately BELOW the 0.5 px cross-world
        # tolerance and far above the 0.0001 px equality this clause asserts, which is the whole of
        # what keeps the two disjoint.
        def ratio(w, _n=same[0]):
            row = w[_n]["adv"]["mono"][size]
            row[1] = round(row[1] + 0.3, 4)
        out.append({"clause": "ratio-independence", "apply": ratio,
                    "what": "mono %spx U+0021 widened by 0.3 px in %s alone, which is under the "
                            "%.1f px cross-world tolerance on purpose" % (size, same[0],
                                                                          TOLERANCE_PX)})

    ref_name = REFERENCE if REFERENCE in live else (live[0] if live else "")
    if ref_name:
        def kerning(w, _n=ref_name):
            run = w[_n]["runs"]["mono"][size][0]
            run["measured"] = round(run["measured"] + 1.0, 4)
        out.append({"clause": "kerning-mono", "apply": kerning,
                    "what": "%s's measured mono width of %r widened by 1.0 px, leaving the summed "
                            "advances alone" % (ref_name, worlds[ref_name]["strings"][0])})

        def coupling(w, _n=ref_name):
            cell = w[_n]["fonts"]["mono"][size]
            cell["renderer"] = "%s /* injected */" % cell["renderer"]
        out.append({"clause": "coupling", "apply": coupling,
                    "what": "%s's mono %spx renderer font string altered, so it stops matching "
                            "the declared stack" % (ref_name, size)})
    return out


# ---- the artifacts ----------------------------------------------------------------------------

def candidate_table(worlds: dict[str, dict], sizes: tuple[int, ...]) -> dict:
    """THE TABLE ITSELF, as `src/abi.mjs` would publish it: the reference world, declared sizes.

    A SEPARATE FILE FROM THE VERDICT, and not a section of it. Six worlds times every measured
    size is 1.4 MB of numbers nobody reads, while the table a milestone would paste is 95 advances
    per variant per DECLARED size out of ONE world — so the two have different readers and
    different lifetimes. A size that was measured but is not declared is absent here on purpose:
    the plan's design is that an undeclared size has no row (`docs/PLAN-SHELL.md` §2 M19).
    """
    name = REFERENCE if REFERENCE in worlds and "adv" in worlds[REFERENCE] else next(
        (n for n in worlds if "adv" in worlds[n]), "")
    if not name:
        return {"error": "no world reported a table"}
    w = worlds[name]
    declared = [s for s in sizes if s in SIZES_DECLARED]
    return {
        "measuredIn": name,
        "dpr": w.get("dpr"),
        "ua": w.get("ua"),
        "unit": "surface px, the unit DL_TEXT's a2 carries",
        "families": w.get("families"),
        "sizes": declared,
        "chars": w.get("chars"),
        "adv": {v: {str(s): row for s, row in ((int(k), r) for k, r in bysize.items())
                    if s in declared}
                for v, bysize in (w.get("adv") or {}).items()},
    }


def thin(worlds: dict[str, dict]) -> dict:
    """Every world WITHOUT its tables: what engine, what ratio, what font, what the renderer did.

    The numbers live in the clauses (worst per size, per string, per engine) and in the candidate
    table. Keeping a third copy of them here is what made the first artifact 1.4 MB.
    """
    keep = ("askedDpr", "dpr", "isolated", "ua", "families", "surface", "setViewport",
            "error", "sizes", "strings")
    out = {}
    for n, w in worlds.items():
        row = {k: v for k, v in w.items() if k in keep}
        # ONE FONT PAIR PER VARIANT and not one per size: the pairs differ only in the `Npx`
        # prefix, and the `coupling` clause carries the count of cells that were compared, so
        # keeping 17 near-identical strings per variant per world records nothing extra.
        fonts = w.get("fonts") or {}
        row["fontSample"] = {v: bysize[min(bysize, key=int)]
                             for v, bysize in fonts.items() if bysize}
        out[n] = row
    return out


# ---- the verdict ------------------------------------------------------------------------------

def _cells(world: dict):
    """(variant, size, index) -> advance, for every measured cell of one world."""
    for variant, bysize in (world.get("adv") or {}).items():
        for size, row in bysize.items():
            for i, v in enumerate(row):
                yield variant, int(size), i, v


def score(worlds: dict[str, dict]) -> tuple[dict, list[str]]:
    """Every scored clause, as `{clause: {"ok": bool, ...}}`, plus the lines a reader reads."""
    notes: list[str] = []
    live = {n: w for n, w in worlds.items() if "adv" in w and not w.get("error")}
    clauses: dict[str, dict] = {}

    # ---- clause: every world reported a table ----
    missing = sorted(n for n, w in worlds.items() if n not in live)
    clauses["delivery"] = {
        "ok": not missing and len(live) >= 2,
        "worlds": sorted(live),
        "missing": {n: (worlds[n].get("error") or "no table") for n in missing},
    }
    for n in missing:
        notes.append("%-16s NO TABLE: %s" % (n, worlds[n].get("error") or "unknown"))
    if not live:
        return clauses, notes + ["nothing was measured in any engine"]

    # ---- clause: the renderer's font IS the declared stack ----
    bad_fonts = []
    checked = 0
    for n, w in live.items():
        for variant, bysize in (w.get("fonts") or {}).items():
            for size, pair in bysize.items():
                checked += 1
                if pair.get("renderer") != pair.get("declared"):
                    bad_fonts.append("%s %s %spx: renderer %r != declared %r"
                                     % (n, variant, size, pair.get("renderer"),
                                        pair.get("declared")))
    clauses["coupling"] = {"ok": not bad_fonts and checked > 0, "mismatches": bad_fonts[:8],
                           "count": len(bad_fonts), "cellsChecked": checked}
    if bad_fonts:
        notes.append("THE FONT MEASURED IS NOT THE FONT DECLARED, in %d of the cells; first: %s"
                     % (len(bad_fonts), bad_fonts[0]))

    # ---- clause: one table serves every world, within the tolerance ----
    chars = next(iter(live.values()))["chars"]
    tables = {n: {(v, s, i): a for v, s, i, a in _cells(w)} for n, w in live.items()}
    keys = set.intersection(*(set(t) for t in tables.values())) if tables else set()
    if not keys:
        # NO CELL IS COMMON TO EVERY WORLD, so there is nothing to compare. Reported and returned
        # rather than left to raise out of the arithmetic below: a harness must say what it could
        # not measure, and a traceback says it to the wrong reader.
        clauses["cross-world"] = {"ok": False, "reference": None, "cells": 0,
                                  "why": "no (variant, size, code point) cell was measured in "
                                         "every world, so the tables cannot be compared"}
        return clauses, notes + ["the worlds share no measured cell, so nothing was compared"]
    ref_name = REFERENCE if REFERENCE in tables else sorted(tables)[0]
    per_size_dev: dict[int, dict] = {}
    per_size_spread: dict[int, dict] = {}
    for key in keys:
        variant, size, i = key
        values = [tables[n][key] for n in tables]
        spread = max(values) - min(values)
        dev = max(abs(tables[n][key] - tables[ref_name][key]) for n in tables)
        worst_at = max(tables, key=lambda n: abs(tables[n][key] - tables[ref_name][key]))
        cur = per_size_dev.get(size)
        if cur is None or dev > cur["px"]:
            per_size_dev[size] = {"px": round(dev, 4), "variant": variant,
                                  "char": chars[i], "code": 0x20 + i, "world": worst_at}
        cur = per_size_spread.get(size)
        if cur is None or spread > cur["px"]:
            per_size_spread[size] = {"px": round(spread, 4), "variant": variant,
                                     "char": chars[i], "code": 0x20 + i,
                                     "values": {n: tables[n][key] for n in tables}}
    worst_dev = max((r["px"] for r in per_size_dev.values()), default=math.inf)
    worst_spread = max((r["px"] for r in per_size_spread.values()), default=math.inf)
    clauses["cross-world"] = {
        "ok": bool(keys) and worst_dev <= TOLERANCE_PX,
        "reference": ref_name, "tolerance": TOLERANCE_PX,
        "worstPx": None if worst_dev == math.inf else worst_dev,
        # HALF THE SPREAD is the error of the BEST table that could be published — the midpoint of
        # every world's figure — so it says how much of the tolerance the reference world is
        # spending by being a world rather than an average.
        "worstSpreadPx": None if worst_spread == math.inf else worst_spread,
        "bestAchievablePx": None if worst_spread == math.inf else round(worst_spread / 2, 4),
        "perSize": {str(s): per_size_dev[s] for s in sorted(per_size_dev)},
        "perSizeSpread": {str(s): per_size_spread[s] for s in sorted(per_size_spread)},
        "cells": len(keys),
    }

    # WHICH CODE POINTS DISAGREE AT ALL, as a count per character. The worst figure above is one
    # cell; this says whether the table is uniformly a little wrong or wrong in one row — and those
    # are different repairs. A column laid out from a table that is exact in 94 of 95 code points
    # can be fitted on the 94 and avoid the one.
    noisy: dict[str, dict] = {}
    for key in keys:
        values = [tables[n][key] for n in tables]
        sp = max(values) - min(values)
        if sp <= RATIO_EPSILON:
            continue
        c = chars[key[2]]
        cur = noisy.setdefault(c, {"code": 0x20 + key[2], "cells": 0, "worstPx": 0.0,
                                   "variants": [], "sizes": []})
        cur["cells"] += 1
        cur["worstPx"] = max(cur["worstPx"], round(sp, 4))
        if key[0] not in cur["variants"]:
            cur["variants"].append(key[0])
        if key[1] not in cur["sizes"]:
            cur["sizes"].append(key[1])
    for cur in noisy.values():
        cur["variants"].sort()
        cur["sizes"].sort()
    # ONLY THE ONES A LAYOUT COULD SEE ARE KEPT CELL BY CELL. All 95 disagree at the fourth
    # decimal, which is the engines' own rounding; recording each one's 68 cells made the artifact
    # four times the size of the finding in it. The rest are kept as a count and their largest.
    loud = {c: r for c, r in noisy.items() if r["worstPx"] > REPORT_FLOOR_PX}
    clauses["cross-world"]["disagreeingChars"] = loud
    clauses["cross-world"]["disagreeingCharCount"] = len(noisy)
    clauses["cross-world"]["quietWorstPx"] = max(
        (r["worstPx"] for c, r in noisy.items() if c not in loud), default=0.0)
    clauses["cross-world"]["reportFloorPx"] = REPORT_FLOOR_PX
    clauses["cross-world"]["charsMeasured"] = len(chars)

    # ---- clause: the table is not RATIO-shaped ----
    # THE DECOMPOSITION THAT DECIDES WHETHER A TABLE NEEDS A dpr DIMENSION, and the one CLAUDE.md's
    # standing finding predicts will bite: M11's blur band and M12's window count were each a
    # constant that was right at one ratio. Within ONE engine, across its ratios, nothing about a
    # font may move — `measureText` runs in the canvas's coordinate space and a backing store is
    # not a ratio. If this is non-zero, the table is indexed in the wrong unit.
    engines: dict[str, list[str]] = {}
    for n in live:
        engines.setdefault(n.split("@", 1)[0], []).append(n)
    multi = {e: ns for e, ns in engines.items() if len(ns) > 1}
    per_engine: dict[str, dict] = {}
    for engine, names in multi.items():
        worst = {"px": 0.0}
        for key in keys:
            values = [tables[n][key] for n in names]
            sp = max(values) - min(values)
            if sp > worst["px"]:
                worst = {"px": round(sp, 4), "variant": key[0], "size": key[1],
                         "char": chars[key[2]], "code": 0x20 + key[2],
                         "values": {n: tables[n][key] for n in names}}
        per_engine[engine] = {"ratios": sorted(live[n].get("dpr") for n in names), "worst": worst}
    worst_ratio = max((r["worst"]["px"] for r in per_engine.values()), default=math.inf)
    clauses["ratio-independence"] = {
        "ok": bool(multi) and worst_ratio <= RATIO_EPSILON,
        # NOT MEASURED AND MEASURED-AND-MOVED ARE DIFFERENT STATES, and both are red. A run given
        # one ratio per engine cannot say the table is ratio-independent, and must not.
        "measured": bool(multi),
        "epsilon": RATIO_EPSILON,
        "worstPx": None if worst_ratio == math.inf else worst_ratio,
        "perEngine": per_engine,
    }

    # ---- clauses: a string's width IS the sum of its characters' advances ----
    # SCORED PER FAMILY, because the two families cannot give one answer: a monospaced advance is
    # the same for every code point and a proportional one is kerned per pair. One clause over
    # both would be satisfied by the mono half and hide the half M19's Name column lives in.
    kern: dict[str, dict] = {}
    for family in ("mono", "proportional"):
        want_mono = family == "mono"
        per_size: dict[int, dict] = {}
        per_string: dict[str, dict] = {}
        signed: list[float] = []
        rel: dict = {"frac": 0.0}
        for n, w in live.items():
            for variant, bysize in (w.get("runs") or {}).items():
                if (variant.startswith("mono")) != want_mono:
                    continue
                for size, rows in bysize.items():
                    for j, row in enumerate(rows):
                        if row.get("sum") is None or row.get("measured") is None:
                            continue
                        delta = row["measured"] - row["sum"]
                        if delta != delta:  # NaN: a code point the table has no row for
                            continue
                        signed.append(delta)
                        err = abs(delta)
                        name = w["strings"][j]
                        where = {"px": round(err, 4), "signedPx": round(delta, 4),
                                 "variant": variant, "world": n, "size": int(size),
                                 "string": name, "measured": row["measured"],
                                 "sum": row["sum"]}
                        cur = per_size.get(int(size))
                        if cur is None or err > cur["px"]:
                            per_size[int(size)] = where
                        cur = per_string.get(name)
                        if cur is None or err > cur["px"]:
                            per_string[name] = where
                        if row["measured"] > 0:
                            frac = err / row["measured"]
                            if frac > rel["frac"]:
                                rel = dict(where, frac=round(frac, 5))
        worst = max((r["px"] for r in per_size.values()), default=math.inf)
        kern[family] = {
            "ok": bool(per_size) and worst <= TOLERANCE_PX,
            "tolerance": TOLERANCE_PX,
            "worstPx": None if worst == math.inf else worst,
            # THE SIGN IS THE DESIGN QUESTION, not a curiosity: a sum that is never below the
            # measured width is a safe UPPER BOUND — a column fitted from it is too wide and never
            # too narrow — and one that straddles zero is neither bound nor estimate.
            "signedRange": [round(min(signed), 4), round(max(signed), 4)] if signed else None,
            "worstRelative": rel if rel["frac"] else None,
            "perSize": {str(s): per_size[s] for s in sorted(per_size)},
            "perString": per_string,
            "samples": len(signed),
        }
    clauses["kerning-mono"] = kern["mono"]
    clauses["kerning-proportional"] = kern["proportional"]

    # ---- reported, NOT scored: is an advance linear in the size? ----
    # A scaled model needs one row per family instead of one per size. It is reported because the
    # plan already chose a per-size table; the figure says what that choice costs or saves.
    # THE LARGEST SIZE ACTUALLY MEASURED, not the default set: `--size` moves it, and the model is
    # scaled DOWN from the largest row because that is where the font has the most to say.
    base = max(size for _, size, _ in keys)
    worst_linear = {"px": 0.0}
    for n, w in live.items():
        adv = w.get("adv") or {}
        for variant, bysize in adv.items():
            ref_row = bysize.get(str(base))
            if not ref_row:
                continue
            for size, row in bysize.items():
                k = int(size) / base
                for i, v in enumerate(row):
                    err = abs(v - ref_row[i] * k)
                    if err > worst_linear["px"]:
                        worst_linear = {"px": round(err, 4), "world": n, "variant": variant,
                                        "size": int(size), "char": chars[i],
                                        "scaled": round(ref_row[i] * k, 4), "measured": v}
    # REPORTED AND NOT SCORED, so it carries no `ok`: the plan already chose a per-size table and
    # this says what that choice is worth. Named `scaled-table` after the model it rejects.
    clauses["scaled-table"] = {"reported": True, "emSize": base, "worst": worst_linear,
                               "withinTolerance": worst_linear["px"] <= TOLERANCE_PX}

    # ---- the lines a reader reads ----
    notes.append("worlds measured: %s   (reference %s)"
                 % (", ".join("%s dpr=%s" % (n, live[n].get("dpr")) for n in sorted(live)),
                    ref_name))
    for n in sorted(live):
        w = live[n]
        # THE ENGINE'S OWN VERSION, beside the number it produced. CLAUDE.md's rule for a figure
        # measured on a machine that is not the reference one, and this run is on Chrome 158 where
        # `docs/CONSTRAINTS.md` names 157.
        ua = w.get("ua") or ""
        build = re.search(r"(Chrome|HeadlessChrome|Firefox)/([\d.]+)", ua)
        notes.append("  %-16s dpr %-4s isolated=%s  %-24s text runs %s, unknown ops %s"
                     % (n, w.get("dpr"), w.get("isolated"),
                        "%s %s" % build.groups() if build else "engine unnamed",
                        (w.get("surface") or {}).get("text"),
                        (w.get("surface") or {}).get("unknown")))
    notes.append("WITHIN one engine, across its ratios, the worst advance movement:")
    for engine in sorted(per_engine):
        r = per_engine[engine]
        mark = " " if r["worst"]["px"] <= RATIO_EPSILON else "!"
        notes.append("  %s %-8s ratios %-16s %7.4f px%s"
                     % (mark, engine, ",".join(str(x) for x in r["ratios"]), r["worst"]["px"],
                        "" if r["worst"]["px"] <= RATIO_EPSILON
                        else "   at %s %spx %r" % (r["worst"].get("variant"),
                                                   r["worst"].get("size"),
                                                   r["worst"].get("char"))))
    notes.append("per size, the WORST advance deviation from %s over %d cells "
                 "(best a midpoint table could do: %.4f px):"
                 % (ref_name, len(keys), (clauses["cross-world"]["bestAchievablePx"] or 0)))
    for s in sorted(per_size_dev):
        r = per_size_dev[s]
        mark = " " if r["px"] <= TOLERANCE_PX else "!"
        tag = "declared" if s in SIZES_DECLARED else "        "
        notes.append("  %s %2dpx %s  %7.4f px   worst at %s %r (U+%04X) in %s"
                     % (mark, s, tag, r["px"], r["variant"], r["char"], r["code"], r["world"]))
    # LISTED ONLY WHERE IT MATTERS. Every code point disagrees at the fourth decimal, which is the
    # two engines' own rounding and not a finding; the ones worth a line are the ones a layout
    # could see. The rest are summarised by their largest, so the cut is visible rather than silent.
    cw = clauses["cross-world"]
    loud = cw["disagreeingChars"]
    notes.append("code points that disagree between worlds at all: %d of %d; %d by more than "
                 "%.2f px, and the largest of the rest is %.4f px"
                 % (cw["disagreeingCharCount"], cw["charsMeasured"], len(loud),
                    REPORT_FLOOR_PX, cw["quietWorstPx"]))
    for c, r in sorted(loud.items(), key=lambda kv: -kv[1]["worstPx"]):
        notes.append("  %r (U+%04X)  worst %.4f px in %d cells, variants %s, sizes %s"
                     % (c, r["code"], r["worstPx"], r["cells"], ",".join(r["variants"]),
                        ",".join(str(s) for s in r["sizes"])))
    for family in ("mono", "proportional"):
        c = kern[family]
        lo, hi = c["signedRange"] or (0.0, 0.0)
        notes.append("%s: per size, the WORST |measureText(string) - sum of advances| "
                     "(%d samples, signed range %+.4f..%+.4f px):"
                     % (family, c["samples"], lo, hi))
        for s in sorted(c["perSize"], key=int):
            r = c["perSize"][s]
            mark = " " if r["px"] <= TOLERANCE_PX else "!"
            notes.append("  %s %2spx  %7.4f px   %r in %s %s (measured %.4f, summed %.4f)"
                         % (mark, s, r["px"], r["string"], r["world"], r["variant"],
                            r["measured"], r["sum"]))
        rel = c.get("worstRelative")
        if rel:
            notes.append("  worst as a FRACTION of the string's width: %.2f%% (%r at %s %spx)"
                         % (rel["frac"] * 100, rel["string"], rel["variant"], rel["size"]))
    notes.append("proportional: the WORST error per string, over every world, variant and size:")
    for name, r in sorted(kern["proportional"]["perString"].items(),
                          key=lambda kv: -kv[1]["px"]):
        notes.append("  %8.4f px  %-32r %s %spx" % (r["px"], name, r["variant"], r["size"]))
    notes.append("linearity: scaling the %dpx row gives a worst error of %.4f px (%s %s %spx %r)"
                 % (base, worst_linear["px"], worst_linear.get("world"),
                    worst_linear.get("variant"), worst_linear.get("size"),
                    worst_linear.get("char")))
    return clauses, notes


def verdict(clauses: dict) -> str:
    cross = clauses.get("cross-world") or {}
    mono = clauses.get("kerning-mono") or {}
    prop = clauses.get("kerning-proportional") or {}
    if not (clauses.get("delivery") or {}).get("ok"):
        return ("UNDECIDED: not every world reported a table, so no statement about a published "
                "table is supported.")
    if not (clauses.get("coupling") or {}).get("ok"):
        return ("UNDECIDED: the font measured is not the font `src/wm/surface.mjs` declares, so "
                "the figures are not about the renderer's font.")
    ratio = clauses.get("ratio-independence") or {}
    if not ratio.get("measured"):
        return ("UNDECIDED: no engine was measured at more than one ratio, so whether the table "
                "is indexed in the right unit was not measured. Pass at least two `--dpr`.")
    if not ratio.get("ok"):
        return ("THE TABLE WOULD HAVE TO BE INDEXED BY THE DEVICE RATIO as well as the size: one "
                "engine's own advances move by %.4f px between its ratios, so a surface-px index "
                "is the wrong index and nothing below this is safe to conclude."
                % (ratio.get("worstPx") or 0))
    if not cross.get("ok"):
        return ("A TABLE CANNOT BE PUBLISHED AT ALL: one table does not serve every world "
                "(worst %.4f px against %s, over %d cells). `DLT_ELLIPSIS` carries R20 alone."
                % (cross.get("worstPx") or 0, cross.get("reference"), cross.get("cells") or 0))
    lo, hi = prop.get("signedRange") or (0.0, 0.0)
    bound = ("an UPPER BOUND" if hi <= 0.0 + 1e-9 else
             "a LOWER BOUND" if lo >= 0.0 - 1e-9 else "NEITHER BOUND")
    if mono.get("ok") and prop.get("ok"):
        return ("A COLUMN CAN BE FITTED FROM A PUBLISHED TABLE in either family. Worst "
                "cross-world advance deviation %.4f px; worst string-vs-sum error %.4f px "
                "(mono) and %.4f px (proportional), all inside %.1f px."
                % (cross.get("worstPx") or 0, mono.get("worstPx") or 0,
                   prop.get("worstPx") or 0, TOLERANCE_PX))
    if mono.get("ok") and not prop.get("ok"):
        rel = (prop.get("worstRelative") or {}).get("frac") or 0.0
        return ("A MONOSPACED COLUMN CAN BE FITTED EXACTLY (worst %.4f px) AND A PROPORTIONAL ONE "
                "CANNOT: the table serves every world to %.4f px, but a summed width is wrong by "
                "up to %.4f px (%.2f%% of the string) because the renderer KERNS. The sum is %s, "
                "so a fitted proportional column is too WIDE and never too narrow; a width a "
                "reader must trust stays proportional with `DLT_ELLIPSIS` carrying R20."
                % (mono.get("worstPx") or 0, cross.get("worstPx") or 0,
                   prop.get("worstPx") or 0, rel * 100, bound))
    return ("A COLUMN MUST STAY PROPORTIONAL and `DLT_ELLIPSIS` carries R20 alone: a string's "
            "width is not the sum of its advances in either family (mono %.4f px, proportional "
            "%.4f px, tolerance %.1f px)."
            % (mono.get("worstPx") or 0, prop.get("worstPx") or 0, TOLERANCE_PX))


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--headed", action="store_true",
                    help="drive real windows, for a human watching. The suite is headless.")
    ap.add_argument("--dpr", type=float, action="append", default=[],
                    help="a ratio to measure at, repeatable. Default: 1, 1.5, 2.")
    ap.add_argument("--only", choices=("chrome", "firefox"), default="",
                    help="one engine. The verdict then says so rather than claiming both.")
    ap.add_argument("--size", type=int, action="append", default=[],
                    help="a surface-px size to measure, repeatable. Default: 10..26, the "
                         "contiguous superset of the declared set. Use it to ask where the "
                         "declared set's upper edge would breach the tolerance.")
    ap.add_argument("--prove-failure", action="store_true",
                    help="break each scored clause in a named place; the run MUST report it")
    ap.add_argument("--out", default="")
    args = ap.parse_args(argv[1:])
    ratios = tuple(args.dpr) if args.dpr else RATIOS
    sizes = tuple(sorted({s for s in args.size if s > 0})) if args.size else SIZES_MEASURED
    if not sizes:
        print("no positive size was asked for", file=sys.stderr)
        return 2

    os.chdir(REPO)
    httpd = serve.Server(("127.0.0.1", 0), serve.Handler)
    port = httpd.server_address[1]
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    base = "http://127.0.0.1:%d" % port
    tag = "headed" if args.headed else "headless"
    # A PROVE-FAILURE RUN MUST NOT LAND ON THE REAL ARTIFACT. Its tables carry injected numbers,
    # and a reader who ran the flag once would otherwise be reading them as measurements.
    if args.prove_failure and not args.out:
        tag += "-prove-failure"
    out_path = pathlib.Path(args.out) if args.out else HERE / ("results-%s.json" % tag)
    # DERIVED FROM `--out`, and it must never COLLIDE with it: a stem without "results" in it gets
    # a suffix instead of a substitution, or the table would be written over the verdict.
    stem = out_path.stem
    table_path = out_path.with_name(
        (stem.replace("results", "table", 1) if "results" in stem else stem + "-table") + ".json")
    print("m19 advance probe  %s%s  (%s)" % (base, DOC, tag), file=sys.stderr)
    print("declared sizes (surface px): %s" % ", ".join(str(s) for s in SIZES_DECLARED),
          file=sys.stderr)

    worlds: dict[str, dict] = {}
    try:
        if args.only != "firefox":
            worlds.update(measure_chrome(base, ratios, args.headed, sizes))
        if args.only != "chrome":
            try:
                worlds.update(measure_firefox(base, ratios, args.headed, sizes))
            except Exception as err:
                # NAMED, NOT SWALLOWED. A missing second engine is the gap this probe exists to
                # close, so it must read as a sentence and fail the run rather than disappear.
                worlds["firefox@unavailable"] = {"error": "Firefox could not be driven: %s"
                                                          % str(err)[:300]}
    finally:
        httpd.shutdown()

    clauses, notes = score(worlds)
    scored = {k: v for k, v in clauses.items() if "ok" in v}
    failed = sorted(k for k, v in scored.items() if not v.get("ok"))
    green = {k for k, v in scored.items() if v.get("ok")}

    controls: list[dict] = []
    if args.prove_failure:
        # EACH CONTROL ALONE, AGAINST THE UNMODIFIED TABLES. `score` is pure arithmetic over the
        # collected worlds, so a control costs a deep copy and no browser run — which is what makes
        # scoring them one at a time affordable, and scoring them together dishonest.
        for control in injections(worlds):
            w2 = copy.deepcopy(worlds)
            control["apply"](w2)
            c2 = score(w2)[0]
            moved = sorted(k for k in green if not (c2.get(k) or {}).get("ok"))
            controls.append({"clause": control["clause"], "what": control["what"],
                             "moved": moved, "ok": moved == [control["clause"]]})

    out = {
        "ok": not failed,
        "sizesDeclared": list(SIZES_DECLARED),
        "sizesMeasured": list(sizes),
        "declaredFrom": {"cssSizes": list(DECLARED_CSS), "ratios": list(RATIOS)},
        "tolerancePx": TOLERANCE_PX,
        "clauses": clauses,
        "failed": failed,
        "controls": controls,
        "verdict": verdict(clauses),
        "notes": notes,
        "worlds": thin(worlds),
        "table": str(table_path),
    }
    out_path.write_text(json.dumps(out, indent=2) + "\n")
    # COMPACT, because it is 4,180 numbers and a reader reaches it through a program rather than
    # by eye. The verdict file above is the one a person opens.
    table_path.write_text(json.dumps(candidate_table(worlds, sizes)) + "\n")

    for line in notes:
        print(line)
    print()
    for name in sorted(scored):
        print("  %-12s %s" % (name, "ok" if scored[name].get("ok") else "FAILED"))
    print("\n%s" % out["verdict"])
    if failed == ["kerning-proportional"]:
        # SAID IN THE OUTPUT AND NOT ONLY IN A DOCSTRING, because a non-zero exit from a probe
        # reads as a broken probe, and here it is the answer.
        print("The exit status is 1 because a clause is red. On an unmodified tree that clause is "
              "`kerning-proportional`, and its being red IS this probe's finding — not a "
              "malfunction. Any other red clause is.")
    print("wrote %s" % out_path)
    print("wrote %s  — the candidate table itself, at the declared sizes" % table_path)

    if args.prove_failure:
        # THE PROOF IS THAT EACH CONTROL MOVED ITS OWN CLAUSE AND NOTHING ELSE. "Something failed"
        # is satisfied by a control that breaks the arithmetic, which verifies nothing.
        print("\ncontrols, each applied ALONE to the unmodified tables:")
        for c in controls:
            print("  %-19s %s" % (c["clause"], "ok" if c["ok"] else "WRONG SUBSET"))
            print("      %s" % c["what"])
            print("      moved: %s" % (", ".join(c["moved"]) or "nothing"))
        print("  `kerning-proportional` gets no control: it is red on the unmodified tree, so "
              "there is nothing for one to demonstrate about it.")
        if not controls:
            print("PROOF FAILED: no control could be built, so no clause was shown capable of "
                  "failing.")
            return 1
        bad = [c["clause"] for c in controls if not c["ok"]]
        if not bad:
            print("PROOF SUCCEEDED: every clause green on the unmodified tree is capable of "
                  "failing, and each control moves its own clause alone.")
            return 0
        print("PROOF FAILED: %s moved the wrong set, so %s not coupled to what it claims."
              % (", ".join(bad), "it is" if len(bad) == 1 else "they are"))
        return 1
    return 0 if not failed else 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
