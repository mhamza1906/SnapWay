"""Resumable batches, interruption, telemetry and cache reuse (offline fake client)."""

from __future__ import annotations

from types import SimpleNamespace

import httpx
import numpy as np
import pytest
from PIL import Image

from placematch.backends.base import RequestBudget, RequestLimitExceeded
from placematch.backends.gemini import GeminiBackend
from placematch.ops.telemetry import Telemetry, percentiles
from placematch.retrieval import embed_only, estimate, run_retrieval
from placematch.schemas import Manifest, ManifestEntry


class Interrupt(BaseException):
    """Stands in for a kill: not an Exception, so nothing in the backend swallows it."""


class FakeClient:
    def __init__(self, interrupt_after=None):
        self.shas, self.interrupt_after = [], interrupt_after
        self.models = SimpleNamespace(embed_content=self.embed_content)

    def embed_content(self, *, model, contents, config):
        data = contents[0].parts[0].inline_data.data
        if self.interrupt_after is not None and len(self.shas) >= self.interrupt_after:
            raise Interrupt()
        self.shas.append(hash(data))
        vec = np.random.default_rng(len(data)).normal(size=config.output_dimensionality)
        return SimpleNamespace(embeddings=[SimpleNamespace(values=vec.tolist())])


@pytest.fixture
def bench(tmp_path):
    entries = []
    for i in range(6):
        p = tmp_path / f"im{i}.png"
        arr = np.random.default_rng(i).integers(0, 255, (30, 40, 3), dtype=np.uint8)
        Image.fromarray(arr).save(p)
        role = "reference" if i < 3 else "query"
        entries.append(
            ManifestEntry(image_id=f"{role}{i}", path=str(p), role=role, dataset="x", scene_id="s")
        )
    m = Manifest(name="t", entries=entries)
    mp = tmp_path / "m.json"
    mp.write_text(m.model_dump_json())
    return m, mp, tmp_path


def _backend(tmp, client):
    return GeminiBackend(
        dims=128, cache_root=tmp / "c", client=client, base_delay_s=0, concurrency=1
    )


def test_partial_budget_then_resume_without_duplicates(bench):
    m, mp, tmp = bench
    fc = FakeClient()
    b = _backend(tmp, fc)
    st = embed_only(m, mp, b, budget=RequestBudget(limit=2))
    assert st.api_requests == 2 and st.telemetry["remaining_uncached"] == 4
    assert estimate(m, mp, b)["n_uncached"] == 4
    st = embed_only(m, mp, b, budget=RequestBudget(limit=10))
    assert st.api_requests == 4 and st.cache_hits == 2 and st.telemetry["remaining_uncached"] == 0
    assert len(fc.shas) == len(set(fc.shas)) == 6  # every image requested exactly once
    st = embed_only(m, mp, b, budget=RequestBudget(limit=0))
    assert st.api_requests == 0 and st.cache_hits == 6


def test_non_partial_keeps_limit_semantics(bench):
    m, mp, tmp = bench
    fc = FakeClient()
    with pytest.raises(RequestLimitExceeded):
        embed_only(m, mp, _backend(tmp, fc), budget=RequestBudget(limit=5), allow_partial=False)
    assert fc.shas == []


def test_interrupted_batch_keeps_finished_vectors(bench):
    m, mp, tmp = bench
    fc = FakeClient(interrupt_after=3)
    b = _backend(tmp, fc)
    with pytest.raises(Interrupt):
        embed_only(m, mp, b, budget=RequestBudget(limit=6), chunk_size=2)
    assert estimate(m, mp, b)["n_cached"] == 3  # each vector was persisted on arrival
    fc.interrupt_after = None
    b2 = _backend(tmp, fc)  # "new process": same cache directory
    st = embed_only(m, mp, b2, budget=RequestBudget(limit=6))
    assert st.api_requests == 3 and len(set(fc.shas)) == 6 == len(fc.shas)


def test_run_retrieval_fills_timings_and_stats(bench):
    m, mp, tmp = bench
    b = _backend(tmp, FakeClient())
    run = run_retrieval(m, mp, b, budget=RequestBudget(6), out_dir=tmp / "out")
    assert run.stats.api_requests == 6 and run.stats.cold_start is False  # client injected
    assert run.stats.latency_s["embed_per_image"]["n"] == 6
    assert run.stats.peak_rss_mb and run.stats.hardware["chip"]
    q = run.queries[0]
    assert set(q.timings_s) == {"quality", "embed", "search", "total"} and q.timings_s["embed"] > 0
    again = run_retrieval(m, mp, b, budget=RequestBudget(0), out_dir=tmp / "out2")
    assert again.stats.api_requests == 0 and again.stats.cache_hits == 6
    assert again.queries[0].timings_s["embed"] == 0.0


def test_telemetry_counts_http_attempts_by_host():
    t = Telemetry()
    m = t.mark()
    for _ in range(3):
        req = httpx.Request("POST", "https://aiplatform.us.rep.googleapis.com/v1beta1/x")
        t.on_request(req)
        t.on_response(httpx.Response(429 if _ == 0 else 200, request=req))
    d = t.since(m)
    assert d["http_attempts"] == 3 and d["http_by_host"] == {"aiplatform.us.rep.googleapis.com": 3}
    assert d["http_status"] == {"429": 1, "200": 2} and len(d["attempt_latency_s"]) == 3
    assert percentiles([1.0, 2.0, 3.0])["p50"] == 2.0 and percentiles([]) == {"n": 0}
