"""Model-free image measurements used for conditions and duplicate/leakage detection.

* ``sha256`` of the file bytes (exact duplicates).
* 64-bit DCT perceptual hash (pHash): grey, 32x32 area resize, 2-D DCT, the 8x8 lowest
  frequencies compared with their median. Hamming distance <= ``NEAR_DUP_BITS`` flags a
  near-duplicate. This is not a learned model, so it may be used on test images.
* ``lapvar``: variance of the Laplacian of the grey image resized so that its longer side
  is 640 px (7-Scenes frames are already 640x480, so values match bench-v1).
* ``mean_luma`` (0..255) and ``dark_fraction`` (luma < 16) of the same grey image.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import cv2
import numpy as np

NEAR_DUP_BITS = 6
STATS_VERSION = 1


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while chunk := f.read(1 << 20):
            h.update(chunk)
    return h.hexdigest()


def phash_grey(grey: np.ndarray) -> int:
    small = cv2.resize(grey, (32, 32), interpolation=cv2.INTER_AREA).astype(np.float32)
    d = cv2.dct(small)[:8, :8].flatten()
    med = np.median(d[1:])  # DC term excluded from the median
    bits = d > med
    return int("".join("1" if b else "0" for b in bits), 2)


def hamming(a: int, b: int) -> int:
    return int((a ^ b).bit_count())


def grey_640(img: np.ndarray) -> np.ndarray:
    g = img if img.ndim == 2 else cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    h, w = g.shape[:2]
    s = 640.0 / max(h, w)
    if abs(s - 1.0) > 1e-6:
        g = cv2.resize(g, (round(w * s), round(h * s)), interpolation=cv2.INTER_AREA)
    return g


def measure(path: Path) -> dict:
    img = cv2.imread(str(path), cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError(f"cannot read image {path}")
    g = grey_640(img)
    return {
        "sha256": sha256_file(path),
        "phash": f"{phash_grey(g):016x}",
        "lapvar": round(float(cv2.Laplacian(g, cv2.CV_64F).var()), 3),
        "mean_luma": round(float(g.mean()), 3),
        "dark_fraction": round(float((g < 16).mean()), 4),
        "width": int(img.shape[1]),
        "height": int(img.shape[0]),
    }


class StatsCache:
    """JSON cache keyed by absolute path + size + mtime (so rebuilds are fast)."""

    def __init__(self, path: Path) -> None:
        self.path = path
        self.data: dict = {}
        if path.is_file():
            raw = json.loads(path.read_text())
            if raw.get("version") == STATS_VERSION:
                self.data = raw.get("items", {})
        self.dirty = False

    def get(self, img: Path) -> dict:
        p = Path(img).resolve()
        st = p.stat()
        key = str(p)
        sig = f"{st.st_size}:{int(st.st_mtime)}"
        hit = self.data.get(key)
        if hit and hit.get("sig") == sig:
            return hit["stats"]
        stats = measure(p)
        self.data[key] = {"sig": sig, "stats": stats}
        self.dirty = True
        return stats

    def save(self) -> None:
        if self.dirty:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            self.path.write_text(json.dumps({"version": STATS_VERSION, "items": self.data}))
            self.dirty = False


def near_duplicate_pairs(
    hashes: dict[str, int], *, max_bits: int = NEAR_DUP_BITS
) -> list[tuple[str, str, int]]:
    """All pairs with Hamming distance <= ``max_bits`` (vectorised, O(n^2) on 64-bit ints)."""
    ids = sorted(hashes)
    if len(ids) < 2:
        return []
    arr = np.array([hashes[i] for i in ids], dtype=np.uint64)
    bits = np.unpackbits(arr.view(np.uint8).reshape(-1, 8), axis=1).astype(np.uint8)
    out = []
    for i in range(len(ids) - 1):
        d = np.count_nonzero(bits[i + 1 :] != bits[i], axis=1)
        for j in np.flatnonzero(d <= max_bits).tolist():
            out.append((ids[i], ids[i + 1 + j], int(d[j])))
    return out
