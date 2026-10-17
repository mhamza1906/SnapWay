"""Vertex backend, provider identity, cache namespaces and cost (offline, no API calls)."""

from __future__ import annotations

from types import SimpleNamespace

import numpy as np
import pytest
from google.auth.credentials import AnonymousCredentials
from PIL import Image

from placematch.backends import BACKENDS, get_backend
from placematch.backends.base import EmbedStats, RequestBudget
from placematch.backends.gemini import legacy_cache_config, sdk_endpoint, usage_of
from placematch.cache import config_hash
from placematch.ops.pricing import vertex_cost
from placematch.retrieval import estimate
from placematch.schemas import Manifest, ManifestEntry


class FakeVertexClient:
    """Returns the Vertex-style response shape (statistics.token_count, tokens_details)."""

    def __init__(self, dims=3072):
        self.calls, self.dims = 0, dims
        self.models = SimpleNamespace(embed_content=self.embed_content)

    def embed_content(self, *, model, contents, config):
        assert model == "gemini-embedding-2" and len(contents) == 1
        assert len(contents[0].parts) == 1  # one image -> one request -> one vector
        self.calls += 1
        vec = np.random.default_rng(len(contents[0].parts[0].inline_data.data)).normal(
            size=config.output_dimensionality
        )
        stats = SimpleNamespace(
            token_count=258,
            truncated=None,
            tokens_details=[
                SimpleNamespace(modality=SimpleNamespace(value="IMAGE"), token_count=258)
            ],
        )
        return SimpleNamespace(
            embeddings=[SimpleNamespace(values=vec.tolist(), statistics=stats)], metadata=None
        )


@pytest.fixture
def images(tmp_path):
    out = []
    for i in range(3):
        p = tmp_path / f"im{i}.png"
        Image.fromarray(np.random.default_rng(i).integers(0, 255, (40, 50, 3), np.uint8)).save(p)
        out.append(p)
    return out


def _vertex(tmp_path, **kw):
    kw.setdefault("project", "test-project")
    kw.setdefault("location", "us")
    return get_backend(
        "vertex", cache_root=tmp_path / "c", client=FakeVertexClient(kw.get("dims", 3072)),
        credentials=AnonymousCredentials(), base_delay_s=0, **kw,
    )  # fmt: skip


def test_registry_and_key(tmp_path):
    assert BACKENDS == ("vertex", "gemini", "megaloc")
    b = _vertex(tmp_path)
    assert b.key == "vertex:gemini-embedding-2@us:d3072:max1024:jpg90" and b.remote
    cfg = b.config()
    assert cfg["provider"] == "vertex-ai" and cfg["project"] == "test-project"
    assert cfg["location"] == "us" and cfg["model"] == "gemini-embedding-2"
    assert cfg["endpoint_host"] == "aiplatform.us.rep.googleapis.com"
    assert cfg["preprocessing"]["max_side"] == 1024 and cfg["dims"] == 3072


def test_endpoints_from_sdk_config():
    assert sdk_endpoint(False)["endpoint_host"] == "generativelanguage.googleapis.com"
    assert sdk_endpoint(True, "p", "global")["endpoint_host"] == "aiplatform.googleapis.com"
    assert sdk_endpoint(True, "p", "eu")["endpoint_host"] == "aiplatform.eu.rep.googleapis.com"


def test_undocumented_location_and_missing_project_refused(tmp_path, monkeypatch):
    with pytest.raises(ValueError, match="not documented"):
        _vertex(tmp_path, location="us-central1")
    monkeypatch.setenv("VERTEX_PROJECT", "")
    with pytest.raises(RuntimeError, match="VERTEX_PROJECT"):
        get_backend("vertex", project=None, location="us", cache_root=tmp_path)


def test_developer_api_identity_and_bench_v1_namespace_unchanged(tmp_path):
    g = get_backend("gemini", cache_root=tmp_path, client=object())
    assert g.key == "gemini:gemini-embedding-2:d3072:max1024:jpg90"
    assert g.config()["provider"] == "gemini-developer-api"
    assert g.config()["endpoint_host"] == "generativelanguage.googleapis.com"
    # bench-v1 cache directory hash (data/cache/gemini_..._jpg90-bc4700b7cd1d) must not move
    assert config_hash(legacy_cache_config("gemini-embedding-2", 3072, 1024, 90)) == "bc4700b7cd1d"
    assert g.cache.directory.name.endswith("-bc4700b7cd1d")
    m = get_backend("megaloc", cache_root=tmp_path)
    assert m.cache.directory.name.endswith("-a68fdfd71df3") and m.config()["provider"] == "local"


def test_namespaces_separate(tmp_path):
    v = _vertex(tmp_path)
    g = get_backend("gemini", cache_root=tmp_path / "c", client=object())
    variants = [
        v,
        g,
        _vertex(tmp_path, location="eu"),
        _vertex(tmp_path, dims=768),
        _vertex(tmp_path, jpeg_quality=85),
    ]
    assert len({b.key for b in variants}) == len({b.cache.directory for b in variants}) == 5


def test_embeds_usage_cost_and_cache(tmp_path, images):
    b = _vertex(tmp_path, dims=256, concurrency=1)
    st = EmbedStats()
    v = b.embed_paths(images, budget=RequestBudget(3), stats=st)
    assert v.shape == (3, 256) and np.allclose(np.linalg.norm(v, axis=1), 1)
    assert st.api_requests == 3 == b._client.calls
    tel = b.telemetry.since()
    assert tel["usage"]["tokens_image"] == 3 * 258 and len(tel["embed_latency_s"]) == 3
    cost = b.cost_estimate(3, tel["usage"])
    assert cost["basis"] == "usage_metadata_token_count" and cost["tokens"] == 774
    assert cost["usd"] == pytest.approx(774 * 0.45 / 1e6, abs=1e-6)
    st2 = EmbedStats()
    b.embed_paths(images, budget=RequestBudget(0), stats=st2)
    assert st2.cache_hits == 3 and b._client.calls == 3


def test_estimate_reports_cost(tmp_path, images):
    b = _vertex(tmp_path)
    m = Manifest(
        name="t",
        entries=[
            ManifestEntry(image_id=p.stem, path=str(p), role="query", dataset="x", scene_id="s")
            for p in images
        ],
    )
    mp = tmp_path / "m.json"
    mp.write_text(m.model_dump_json())
    est = estimate(m, mp, b)
    assert est["expected_requests"] == 3 and est["provider"] == "vertex-ai"
    assert est["cost_usd"] == vertex_cost(3)["usd"] and est["pricing_checked_utc"]
    assert est["pricing_source"].startswith("https://cloud.google.com/")


def test_usage_of_tolerates_missing_fields():
    res = SimpleNamespace(embeddings=[SimpleNamespace(values=[1.0])])
    assert usage_of(res) == {"responses": 1}
