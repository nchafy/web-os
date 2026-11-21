#!/usr/bin/env python3
"""A PNG reader, stdlib only: enough to sample a screenshot's pixels.

    from png import Image
    img = Image.decode(pathlib.Path("shot.png").read_bytes())
    img.rgb(x, y)            # (r, g, b) at a DEVICE pixel
    img.column(x, y0, y1)    # a vertical run of them

WHY THIS EXISTS RATHER THAN A DEPENDENCY. `CLAUDE.md` forbids dependencies without justification,
and the question M11 has to answer is whether a `backdrop-filter` actually blurred — which is a
property of the COMPOSITED output and so is unreachable from inside the page. `getImageData` reads a
canvas, not the compositor; `html2canvas` re-renders the DOM and applies no filter at all. The one
honest source is `Page.captureScreenshot`, and that arrives as a PNG. So a PNG decoder is the price
of asking the question, and 8 bits of zlib plus five filter types is cheaper than Pillow.

WHAT IT DOES NOT DO, deliberately: 16-bit samples, interlacing, palettes and gAMA/sRGB chunks.
Chrome's screenshots are 8-bit non-interlaced RGBA, and a decoder that silently mishandled a format
it had never seen would be worse than one that refuses. Every unsupported case RAISES.
"""
from __future__ import annotations

import dataclasses
import struct
import zlib
from typing import List, Tuple

_MAGIC = b"\x89PNG\r\n\x1a\n"

#: colour type -> bytes per pixel. 0 grey, 2 RGB, 4 grey+alpha, 6 RGBA. 3 (palette) is absent
#: because it needs a PLTE lookup and Chrome does not emit one.
_CHANNELS = {0: 1, 2: 3, 4: 2, 6: 4}


class PngError(ValueError):
    """The bytes are not a PNG this reader can honestly decode."""


@dataclasses.dataclass(frozen=True)
class Image:
    width: int
    height: int
    #: Bytes per pixel, so `rgb` can index without re-deriving the colour type.
    bpp: int
    #: Unfiltered, row-major, `height * width * bpp` bytes.
    data: bytes

    @classmethod
    def decode(cls, raw: bytes) -> "Image":
        if raw[:8] != _MAGIC:
            raise PngError("not a PNG: magic is %r" % raw[:8])
        pos = 8
        header = None
        idat: List[bytes] = []
        while pos + 8 <= len(raw):
            (length,) = struct.unpack_from(">I", raw, pos)
            kind = raw[pos + 4:pos + 8]
            body = raw[pos + 8:pos + 8 + length]
            if len(body) != length:
                raise PngError("chunk %r is truncated: %d of %d bytes"
                               % (kind, len(body), length))
            pos += 12 + length           # length + type + data + crc
            if kind == b"IHDR":
                header = struct.unpack(">IIBBBBB", body)
            elif kind == b"IDAT":
                idat.append(body)
            elif kind == b"IEND":
                break
        if header is None:
            raise PngError("no IHDR chunk")
        width, height, depth, colour, compression, filt, interlace = header
        if depth != 8:
            raise PngError("bit depth %d is not supported; Chrome emits 8" % depth)
        if colour not in _CHANNELS:
            raise PngError("colour type %d is not supported (palettes are not decoded)" % colour)
        if compression != 0 or filt != 0:
            raise PngError("compression %d / filter method %d are not the PNG defaults"
                           % (compression, filt))
        if interlace != 0:
            raise PngError("interlaced PNGs are not supported")
        if not idat:
            raise PngError("no IDAT chunk: there are no pixels to read")
        bpp = _CHANNELS[colour]
        data = _unfilter(zlib.decompress(b"".join(idat)), width, height, bpp)
        return cls(width=width, height=height, bpp=bpp, data=data)

    def rgb(self, x: int, y: int) -> Tuple[int, int, int]:
        """The pixel at a DEVICE pixel coordinate. Raises rather than clamping: a sample that fell
        off the image is a bug in the caller's geometry, and a clamped read would answer with the
        edge pixel and look like a measurement."""
        if not (0 <= x < self.width and 0 <= y < self.height):
            raise PngError("(%d, %d) is outside a %dx%d image" % (x, y, self.width, self.height))
        at = (y * self.width + x) * self.bpp
        if self.bpp >= 3:
            return (self.data[at], self.data[at + 1], self.data[at + 2])
        grey = self.data[at]
        return (grey, grey, grey)

    def column(self, x: int, y0: int, y1: int) -> List[Tuple[int, int, int]]:
        """`y0` inclusive, `y1` exclusive."""
        return [self.rgb(x, y) for y in range(y0, y1)]

    def row(self, y: int, x0: int, x1: int) -> List[Tuple[int, int, int]]:
        return [self.rgb(x, y) for x in range(x0, x1)]


def _unfilter(stream: bytes, width: int, height: int, bpp: int) -> bytes:
    """Reverse the five per-row filters (RFC 2083 §6). One row at a time, because every filter but
    None reads the row above it."""
    stride = width * bpp
    want = height * (stride + 1)
    if len(stream) < want:
        raise PngError("inflated to %d bytes, short of the %d a %dx%d image needs"
                       % (len(stream), want, width, height))
    out = bytearray(height * stride)
    prior = bytearray(stride)
    at = 0
    for y in range(height):
        kind = stream[at]
        row = bytearray(stream[at + 1:at + 1 + stride])
        at += 1 + stride
        if kind == 0:
            pass
        elif kind == 1:                                   # Sub
            for i in range(bpp, stride):
                row[i] = (row[i] + row[i - bpp]) & 0xFF
        elif kind == 2:                                   # Up
            for i in range(stride):
                row[i] = (row[i] + prior[i]) & 0xFF
        elif kind == 3:                                   # Average
            for i in range(stride):
                left = row[i - bpp] if i >= bpp else 0
                row[i] = (row[i] + ((left + prior[i]) >> 1)) & 0xFF
        elif kind == 4:                                   # Paeth
            for i in range(stride):
                left = row[i - bpp] if i >= bpp else 0
                upleft = prior[i - bpp] if i >= bpp else 0
                up = prior[i]
                p = left + up - upleft
                pa, pb, pc = abs(p - left), abs(p - up), abs(p - upleft)
                best = left if (pa <= pb and pa <= pc) else (up if pb <= pc else upleft)
                row[i] = (row[i] + best) & 0xFF
        else:
            raise PngError("row %d carries filter type %d, which is not one of 0-4" % (y, kind))
        out[y * stride:(y + 1) * stride] = row
        prior = row
    return bytes(out)


def monotonic_run(values: List[float], *, slack: float = 0.0) -> bool:
    """Whether `values` never decreases by more than `slack`. The direction is the caller's to
    choose — reverse the list for the other one — because a blur ramp's sign depends on which side
    of the seam the sample started.

    ON ITS OWN THIS PROVES NOTHING ABOUT A BLUR, and that is the reason it carries this note rather
    than being the assertion. A HARD STEP IS MONOTONIC: measured, the bare seam, a `blur(0px)`
    control, a `backdrop-filter: none` control and a severed blur chain all pass it
    (`bench/m11-glass/probe.py`). `PLAN.md` §5 asks M11 for "a monotonic gradient"; the figure that
    actually separates a ramp from a step is `Transition.concentration`."""
    for before, after in zip(values, values[1:]):
        if after < before - slack:
            return False
    return True


# ======================================================================================
# Sampling a glass seam (M11)
# ======================================================================================
#
# ONE DEFINITION, imported by `scripts/check.py` and by `bench/m11-glass/probe.py`. The suite's
# assertion and the bench that chose its threshold have to be the same arithmetic, or the threshold
# is a number about a function nobody runs.


def luma(pixel: Tuple[int, int, int]) -> float:
    """Rec.709, which is the luminance Aero's own afterglow term uses (constraint 34)."""
    r, g, b = pixel
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def band_profile(img: Image, *, seam_x: int, y: int, rows: int, dpr: float,
                 reach_css: int) -> Tuple[List[int], List[float]]:
    """Luminance across a vertical seam, one sample per CSS px, each averaged over `rows` device
    rows and over the dpr-wide device footprint of that CSS px.

    AVERAGING IS HONEST HERE because the seam is VERTICAL: every row in the band sees the same
    horizontal profile, so the mean is of repeated measurements rather than of different ones. One
    row carries a +-1 dither wobble that a monotonicity test would read as a defect.

    Returns `(xs, lumas)` with `xs` in CSS px relative to the seam, negative on the dark side."""
    step = max(1, int(round(dpr)))
    xs: List[int] = []
    out: List[float] = []
    for css in range(-reach_css, reach_css + 1):
        x = seam_x + int(round(css * dpr))
        samples = []
        for row in range(rows):
            for sub in range(step):
                samples.append(luma(img.rgb(x + sub, y + row)))
        xs.append(css)
        out.append(sum(samples) / len(samples))
    return xs, out


@dataclasses.dataclass(frozen=True)
class Transition:
    """What a luminance run across a seam looks like, with no threshold baked in."""
    span: float
    biggest_jump: float
    #: The share of the whole transition that falls between ONE adjacent pair of samples. A hard
    #: step puts all of it there and reads 1.0; a blur spreads it and reads near 1/(2*reach).
    #: THIS IS THE DISCRIMINATOR, and the one `blur(flat) == flat` cannot fake.
    concentration: float
    monotonic: bool
    lumas: Tuple[float, ...]

    def as_dict(self):
        return {
            "span": round(self.span, 2),
            "biggestJump": round(self.biggest_jump, 2),
            "concentration": round(self.concentration, 4),
            "monotonic": self.monotonic,
            "lumas": [round(v, 1) for v in self.lumas],
        }


def transition(lumas: List[float]) -> Transition:
    span = max(lumas) - min(lumas)
    jumps = [b - a for a, b in zip(lumas, lumas[1:])]
    # ABSOLUTE, and a signed `max` was a hole in the gate. A run whose luminance FALLS across the
    # band yields a negative largest jump, so `concentration` came out negative and satisfied
    # `concentration <= M11_SPREAD_MAX` unconditionally — the discriminator stopped discriminating
    # for exactly half of all possible runs. Which direction a seam ramps is a fact about which
    # side of it the sample started, never about whether anything blurred.
    biggest = max((abs(j) for j in jumps), default=0.0)
    return Transition(
        span=span,
        biggest_jump=biggest,
        # A span too small to be a transition at all would make the ratio meaningless, so it is
        # reported as fully concentrated: "there is no spread here" is the honest reading, and the
        # caller's span assertion is what catches a flat band.
        concentration=(biggest / span) if span > 0.5 else 1.0,
        monotonic=monotonic_run(lumas, slack=1.0),
        lumas=tuple(lumas),
    )


def local_range(img: Image, box) -> dict:
    """The luminance spread inside a box, which is the contrast a reader of GLYPHS actually gets.

    WHY A RANGE AND NOT A RATIO AGAINST A DECLARED BACKGROUND. Caption text sits over a blurred
    backdrop whose luminance is unknown — the same caption crosses black and white in one drag — so
    no single pair of (colour, background) has a contrast ratio. Windows 7 answers that with a glow,
    and a glow's contrast is LOCAL: between the glyph core and the halo a pixel or two away. Reading
    a declared `color` against a declared `background` is webxp's own defect, a contrast assertion
    that compared black against itself and passed on any stylesheet (constraint 39)."""
    x, y, w, h = int(box["x"]), int(box["y"]), int(box["w"]), int(box["h"])
    values = []
    for row in range(max(0, h)):
        for col in range(max(0, w)):
            values.append(luma(img.rgb(x + col, y + row)))
    if not values:
        return {"n": 0, "min": None, "max": None, "range": None, "ratio": None}
    lo, hi = min(values), max(values)
    # WCAG 2's contrast ratio, on the two extremes found. Not a claim that every glyph pixel hits
    # it — a claim that the band contains both ends of a legible pair.
    #
    # THE CHANNELS ARE LINEARIZED FIRST, and the first version of this did not do that: it fed
    # gamma-encoded luma straight into (L1+0.05)/(L2+0.05), which is not WCAG's figure and is
    # consistently generous. A glyph/halo pair at luma (128, 0) reads 11.0:1 unlinearized and
    # 5.3:1 correctly; (255, 128) reads 2.6:1 against 1.8:1. Both sit either side of the 4.5
    # threshold, so the clause could have reported AA for a caption that does not meet AA.
    ratio = (_relative_luminance(hi) + 0.05) / (_relative_luminance(lo) + 0.05)
    return {"n": len(values), "min": round(lo, 1), "max": round(hi, 1),
            "range": round(hi - lo, 1), "ratio": round(ratio, 2)}


def _relative_luminance(value: float) -> float:
    """WCAG 2's sRGB linearization, applied to an already-weighted luma.

    An approximation, and a named one: WCAG linearizes the three channels and then weights them,
    while this weights first (`luma`) and linearizes after. The two agree exactly for grey and
    differ for saturated colour. Caption glyphs and their halo are near-neutral here — white text
    on a dark blue glow — so the error is small, and it is in the conservative direction for the
    dark end. A per-channel version would need `local_range` to carry three ranges rather than one,
    which is the shape to reach for if a coloured caption ever appears.
    """
    c = max(0.0, min(1.0, value / 255.0))
    return c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4
