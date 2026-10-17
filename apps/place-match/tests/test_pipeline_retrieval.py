"""Cache, budget, dry run and ranking with a mock remote backend (no API calls)."""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pytest
from PIL import Image

from placematch.backends.base import EmbeddingIndex, EmbedStats, RequestBudget, RequestLimitExceeded
from placematch.cache import EmbeddingCache, backend_slug, embed_with_cache
from placematch.retrieval import estimate, run_retrieval
from placematch.schemas import Manifest, ManifestEntry

COLORS = {"red": (200, 30, 30), "green": (30, 200, 30), "blue": (30, 30, 200)}


class MockBackend:
    """Embeds the mean colour; counts 'requests' like a remote API would."""

    remote = True

    def __init__(self, root: Path, fail: set[str] = frozenset()):
        self.key = "mock:rgb:v1"
        self.cache = EmbeddingCache(self.key, self.config(), root)
        self.sent = 0
        self.fail = fail

    def config(self) -> dict:
        return {"model": "mean-rgb"}

    def requests_for(self, n: int) -> int:
        return n

    def embed_paths(self, paths, *, budget: RequestBudget, stats: EmbedStats) -> np.ndarray:
        def run(todo, shas):
            for p, s in zip(todo, shas, strict=True):
                budget.take(1)
                stats.api_requests += 1
                self.sent += 1
                if p.name in self.fail:
                    stats.failed.append(f"{p}: boom")
                    continue
                self.cache.put(s, np.asarray(Image.open(p)).reshape(-1, 3).mean(0) + 1.0)

        return embed_with_cache(
            [Path(p) for p in paths],
            cache=self.cache,
            requests_for=self.requests_for,
            embed_uncached=run,
            budget=budget,
            stats=stats,
            remote=True,
        )


@pytest.fixture
def bench(tmp_path):
    img = tmp_path / "img"
    img.mkdir()
    entries = []
    for name, rgb in COLORS.items():
        Image.new("RGB", (32, 32), rgb).save(img / f"ref_{name}.png")
        entries.append(
            ManifestEntry(
                image_id=f"reference:{name}",
                path=f"img/ref_{name}.png",
                role="reference",
                dataset="t",
                scene_id="s",
                location_id=name,
            )
        )
    for i, (name, rgb) in enumerate(list(COLORS.items())[:2]):
        Image.new("RGB", (32, 32), tuple(c + 10 for c in rgb)).save(img / f"q_{name}.png")
        entries.append(
            ManifestEntry(
                image_id=f"query:{name}",
                path=f"img/q_{name}.png",
                role="query",
                dataset="t",
                scene_id="s",
                timestamp_s=float(i),
            )
        )
    m = Manifest(name="t", entries=entries)
    mp = tmp_path / "manifest.json"
    mp.write_text(m.model_dump_json())
    return m, mp, tmp_path


def test_dry_run_and_budget_send_nothing(bench):
    m, mp, tmp = bench
    b = MockBackend(tmp / "cache")
    est = estimate(m, mp, b)
    assert {k: est[k] for k in ("backend", "n_images", "n_cached", "n_uncached")} == {
        "backend": "mock:rgb:v1",
        "n_images": 5,
        "n_cached": 0,
        "n_uncached": 5,
    }
    assert est["expected_requests"] == 5 and est["cost_usd"] is None  # no verified price
    dry = run_retrieval(m, mp, b, budget=RequestBudget(1), out_dir=tmp / "out", dry_run=True)
    assert dry.stats.expected_uncached_requests == 5 and dry.stats.api_requests == 0
    with pytest.raises(RequestLimitExceeded):
        run_retrieval(m, mp, b, budget=RequestBudget(4), out_dir=tmp / "out")
    assert b.sent == 0


def test_run_ranks_and_caches(bench):
    m, mp, tmp = bench
    b = MockBackend(tmp / "cache")
    r = run_retrieval(m, mp, b, top_k=2, budget=RequestBudget(5), out_dir=tmp / "out")
    assert r.stats.api_requests == 5 and r.stats.cache_misses == 5 and b.sent == 5
    q = {x.query_id: x for x in r.queries}
    assert q["query:red"].candidates[0].reference_id == "reference:red"
    assert q["query:green"].candidates[0].location_id == "green"
    assert len(q["query:red"].candidates) == 2
    assert q["query:red"].candidates[0].cosine >= q["query:red"].candidates[1].cosine
    assert q["query:red"].quality is not None
    rev = {x.reference_id: x for x in r.references}
    assert rev["reference:red"].best_queries[0].query_id == "query:red"
    assert rev["reference:green"].best_queries[0].timestamp_s == 1.0
    idx = EmbeddingIndex.load(tmp / "out" / "index" / backend_slug(b.key) / "references")
    assert idx.backend_key == b.key and idx.vectors.shape == (3, 3)
    assert np.allclose(np.linalg.norm(idx.vectors, axis=1), 1.0)

    b2 = MockBackend(tmp / "cache")  # new process, same cache
    r2 = run_retrieval(m, mp, b2, budget=RequestBudget(0), out_dir=tmp / "out")
    assert b2.sent == 0 and r2.stats.cache_hits == 5 and r2.stats.api_requests == 0


def test_failed_images_are_reported_not_fatal(bench):
    m, mp, tmp = bench
    b = MockBackend(tmp / "cache", fail={"q_green.png"})
    r = run_retrieval(m, mp, b, budget=RequestBudget(10), out_dir=tmp / "out")
    assert r.stats.failed == 1
    q = {x.query_id: x for x in r.queries}
    assert q["query:green"].candidates == [] and q["query:red"].candidates


def test_cache_separates_configs(tmp_path):
    a = EmbeddingCache("k", {"dims": 1}, tmp_path)
    b = EmbeddingCache("k", {"dims": 2}, tmp_path)
    a.put("x", np.ones(3))
    assert "x" in a.get_many(["x"]) and b.get_many(["x"]) == {}
