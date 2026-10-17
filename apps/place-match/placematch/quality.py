"""Cheap frame-quality flags. Heuristics only: they annotate frames, never drop them.

Measured on the upright image converted to grey and downscaled so its longest side is
``ANALYSIS_MAX_SIDE`` px (keeps blur scores comparable across resolutions).
"""

from __future__ import annotations

from pathlib import Path

import cv2
import numpy as np

from placematch.frames import load_upright
from placematch.schemas import FrameQuality

ANALYSIS_MAX_SIDE = 512
#: Variance of the Laplacian below this => "blurry" (heuristic; textureless walls also score low).
BLUR_LAPLACIAN_VAR_MIN = 60.0
#: Mean luma below this, or more than DARK_FRACTION_MAX of pixels darker than DARK_LUMA.
UNDEREXPOSED_MEAN_MAX = 40.0
DARK_LUMA = 16
DARK_FRACTION_MAX = 0.6
#: Mean luma above this, or more than BRIGHT_FRACTION_MAX of pixels brighter than BRIGHT_LUMA.
OVEREXPOSED_MEAN_MIN = 225.0
BRIGHT_LUMA = 245
BRIGHT_FRACTION_MAX = 0.6


def grey_small(path: Path) -> np.ndarray:
    im = load_upright(path)
    scale = ANALYSIS_MAX_SIDE / max(im.size)
    if scale < 1:
        im = im.resize((round(im.width * scale), round(im.height * scale)))
    return np.asarray(im.convert("L"))


def assess(path: Path) -> FrameQuality:
    g = grey_small(Path(path))
    blur = float(cv2.Laplacian(g, cv2.CV_64F).var())
    mean = float(g.mean())
    dark = float((g < DARK_LUMA).mean())
    bright = float((g > BRIGHT_LUMA).mean())
    flags = []
    if blur < BLUR_LAPLACIAN_VAR_MIN:
        flags.append("blurry")
    if mean < UNDEREXPOSED_MEAN_MAX or dark > DARK_FRACTION_MAX:
        flags.append("underexposed")
    if mean > OVEREXPOSED_MEAN_MIN or bright > BRIGHT_FRACTION_MAX:
        flags.append("overexposed")
    return FrameQuality(
        blur_laplacian_var=round(blur, 3),
        mean_luma=round(mean, 3),
        dark_fraction=round(dark, 4),
        flags=flags,
    )
