"""Embedding backend interface. Owned by the integration (head) layer.

A backend turns one image into one vector. Vectors from different backends (or the
same backend with different settings) live in different indexes and are never
compared; :class:`EmbeddingIndex` enforces this through ``backend_key``.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Protocol, runtime_checkable

import numpy as np


class RequestLimitExceeded(RuntimeError):
    """Raised before any request is sent when uncached work exceeds the request limit."""


@dataclass
class RequestBudget:
    """Caps paid/remote API requests for one run. ``limit=None`` means unlimited."""

    limit: int | None = None
    used: int = 0
    retries: int = 0

    def remaining(self) -> int | None:
        return None if self.limit is None else max(0, self.limit - self.used)

    def take(self, n: int = 1) -> None:
        if self.limit is not None and self.used + n > self.limit:
            raise RequestLimitExceeded(f"request limit {self.limit} reached ({self.used} used)")
        self.used += n


@dataclass
class EmbedStats:
    cache_hits: int = 0
    cache_misses: int = 0
    api_requests: int = 0
    retries: int = 0
    failed: list[str] = field(default_factory=list)
    elapsed_s: float = 0.0


@runtime_checkable
class EmbeddingBackend(Protocol):
    #: Stable identifier including model and preprocessing, e.g.
    #: "gemini:gemini-embedding-2:d3072:max1024". Used for cache keys and index files.
    key: str
    #: True when each uncached image costs remote API requests.
    remote: bool

    def config(self) -> dict:
        """Model id, version, dimensions, preprocessing and task settings (JSON-safe)."""
        ...

    def requests_for(self, n_images: int) -> int:
        """Number of API requests needed to embed ``n_images`` uncached images."""
        ...

    def embed_paths(
        self, paths: list[Path], *, budget: RequestBudget, stats: EmbedStats
    ) -> np.ndarray:
        """Embed each image separately with identical settings.

        Returns float32 array (len(paths), dim), each row L2-normalised. Uses the
        content cache; raises RequestLimitExceeded *before* sending requests if the
        uncached count would exceed ``budget``.
        """
        ...

    def release(self) -> None:
        """Free model/accelerator memory; cached vectors stay on disk."""
        ...


@dataclass
class EmbeddingIndex:
    backend_key: str
    image_ids: list[str]
    vectors: np.ndarray  # float32 (n, d), L2-normalised

    def save(self, directory: Path) -> None:
        directory.mkdir(parents=True, exist_ok=True)
        np.save(directory / "vectors.npy", self.vectors.astype(np.float32))
        (directory / "index.txt").write_text(
            self.backend_key + "\n" + "\n".join(self.image_ids) + "\n", encoding="utf-8"
        )

    @classmethod
    def load(cls, directory: Path) -> EmbeddingIndex:
        lines = (directory / "index.txt").read_text(encoding="utf-8").splitlines()
        return cls(lines[0], lines[1:], np.load(directory / "vectors.npy"))

    def check_compatible(self, other: EmbeddingIndex) -> None:
        if self.backend_key != other.backend_key:
            raise ValueError(
                f"refusing to compare vectors from {self.backend_key!r} and {other.backend_key!r}"
            )


def l2_normalize(x: np.ndarray) -> np.ndarray:
    x = np.asarray(x, dtype=np.float32)
    n = np.linalg.norm(x, axis=1, keepdims=True)
    return x / np.clip(n, 1e-12, None)
