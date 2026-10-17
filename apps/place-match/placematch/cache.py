"""Content-addressed embedding cache, one SQLite file per backend configuration.

An entry is keyed by the sha256 of the image file bytes. The directory name encodes the
backend key plus a hash of its full config, so vectors from different models, dimensions or
preprocessing never share a cache: ``data/cache/<backend_slug>-<config_hash>/embeddings.sqlite``.
"""

from __future__ import annotations

import hashlib
import json
import re
import sqlite3
import threading
from collections.abc import Callable, Iterable
from pathlib import Path

import numpy as np

from placematch.backends.base import EmbedStats, RequestBudget, RequestLimitExceeded, l2_normalize
from placematch.env import DATA_DIR

CACHE_ROOT = DATA_DIR / "cache"


class EmbeddingFailed(RuntimeError):
    """Some images could not be embedded; successful ones are already cached."""

    def __init__(self, failed: list[str]):
        super().__init__(f"{len(failed)} image(s) failed to embed: {failed[:3]}")
        self.failed = failed


def backend_slug(key: str) -> str:
    """Filesystem-safe name for a backend key (used for index and cache directories)."""
    return re.sub(r"[^A-Za-z0-9._-]+", "_", key).strip("_")


def config_hash(config: dict) -> str:
    return hashlib.sha256(json.dumps(config, sort_keys=True).encode()).hexdigest()[:12]


def file_sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


class EmbeddingCache:
    """Thread-safe sha256 -> float32 vector store for one backend configuration."""

    def __init__(self, backend_key: str, config: dict, root: Path | None = None):
        self.backend_key = backend_key
        self.directory = Path(root or CACHE_ROOT) / (
            f"{backend_slug(backend_key)}-{config_hash(config)}"
        )
        self.directory.mkdir(parents=True, exist_ok=True)
        (self.directory / "config.json").write_text(
            json.dumps({"backend_key": backend_key, "config": config}, indent=2, sort_keys=True),
            encoding="utf-8",
        )
        self._lock = threading.Lock()
        self._db = sqlite3.connect(self.directory / "embeddings.sqlite", check_same_thread=False)
        self._db.execute(
            "CREATE TABLE IF NOT EXISTS emb (sha TEXT PRIMARY KEY, dim INTEGER, vec BLOB)"
        )
        self._db.commit()

    def get_many(self, shas: Iterable[str]) -> dict[str, np.ndarray]:
        shas = list(dict.fromkeys(shas))
        out: dict[str, np.ndarray] = {}
        with self._lock:
            for i in range(0, len(shas), 500):
                chunk = shas[i : i + 500]
                q = f"SELECT sha, vec FROM emb WHERE sha IN ({','.join('?' * len(chunk))})"
                for sha, blob in self._db.execute(q, chunk):
                    out[sha] = np.frombuffer(blob, dtype=np.float32).copy()
        return out

    def put(self, sha: str, vec: np.ndarray) -> None:
        v = np.asarray(vec, dtype=np.float32).ravel()
        with self._lock:
            self._db.execute(
                "INSERT OR REPLACE INTO emb (sha, dim, vec) VALUES (?, ?, ?)",
                (sha, v.size, v.tobytes()),
            )
            self._db.commit()

    def count_uncached(self, paths: list[Path]) -> tuple[int, int]:
        """(n_unique_cached, n_unique_uncached) over distinct image contents."""
        shas = {file_sha256(p) for p in paths}
        hit = len(self.get_many(shas))
        return hit, len(shas) - hit


def embed_with_cache(
    paths: list[Path],
    *,
    cache: EmbeddingCache,
    requests_for: Callable[[int], int],
    embed_uncached: Callable[[list[Path], list[str]], None],
    budget: RequestBudget,
    stats: EmbedStats,
    remote: bool,
) -> np.ndarray:
    """Shared cache-first embedding loop used by every backend.

    ``embed_uncached(paths, shas)`` must embed each image separately and call
    ``cache.put(sha, vec)`` per success. Raises :class:`RequestLimitExceeded` before
    sending anything when the uncached work exceeds the budget, and
    :class:`EmbeddingFailed` (after caching the successes) if any image failed.
    """
    shas = [file_sha256(p) for p in paths]
    found = cache.get_many(shas)
    pending: dict[str, Path] = {}
    for sha, p in zip(shas, paths, strict=True):
        if sha in found:
            stats.cache_hits += 1
        else:
            stats.cache_misses += 1
            pending.setdefault(sha, p)
    if pending and remote:
        need = requests_for(len(pending))
        left = budget.remaining()
        if left is not None and need > left:
            raise RequestLimitExceeded(
                f"{need} uncached request(s) needed but only {left} left of limit {budget.limit}"
            )
    if pending:
        embed_uncached(list(pending.values()), list(pending.keys()))
        found.update(cache.get_many(pending))
    missing = sorted({str(p) for sha, p in zip(shas, paths, strict=True) if sha not in found})
    if missing:
        stats.failed.extend(m for m in missing if not any(f.startswith(m) for f in stats.failed))
        raise EmbeddingFailed(missing)
    return l2_normalize(np.stack([found[s] for s in shas]))
