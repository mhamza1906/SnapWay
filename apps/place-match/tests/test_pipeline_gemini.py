"""Gemini backend with a fake client: one image per request, retries, limits (no API calls)."""

from __future__ import annotations

from types import SimpleNamespace

import numpy as np
import pytest
from PIL import Image

from placematch.backends import get_backend
from placematch.backends.base import EmbedStats, RequestBudget, RequestLimitExceeded
from placematch.backends.gemini import GeminiBackend, preprocess
from placematch.cache import EmbeddingFailed


class HttpError(Exception):
    def __init__(self, code):
        super().__init__(f"HTTP {code}")
        self.code = code


class FakeClient:
    def __init__(self, dims=128, errors=()):
        self.calls, self.errors, self.dims = [], list(errors), dims
        self.models = SimpleNamespace(embed_content=self.embed_content)

    def embed_content(self, *, model, contents, config):
        assert len(contents) == 1 and len(contents[0].parts) == 1  # one image -> one vector
        part = contents[0].parts[0]
        assert part.inline_data.mime_type == "image/jpeg"
        self.calls.append(config.output_dimensionality)
        if self.errors:
            raise HttpError(self.errors.pop(0))
        seed = len(part.inline_data.data)
        vec = np.random.default_rng(seed).normal(size=self.dims)
        return SimpleNamespace(embeddings=[SimpleNamespace(values=vec.tolist())])


@pytest.fixture
def images(tmp_path):
    out = []
    for i in range(3):
        p = tmp_path / f"im{i}.png"
        Image.fromarray(
            np.random.default_rng(i).integers(0, 255, (60 + i, 80, 3), dtype=np.uint8)
        ).save(p)
        out.append(p)
    return out


def _backend(tmp_path, client, **kw):
    return GeminiBackend(dims=128, cache_root=tmp_path / "c", client=client, base_delay_s=0, **kw)


def test_key_and_registry(tmp_path):
    b = get_backend("gemini", cache_root=tmp_path, client=FakeClient())
    assert b.key == "gemini:gemini-embedding-2:d3072:max1024:jpg90" and b.remote
    assert b.requests_for(7) == 7 and b.config()["task_type"] is None
    with pytest.raises(ValueError):
        get_backend("nope")


def test_preprocess_deterministic_and_bounded(tmp_path):
    p = tmp_path / "big.png"
    Image.new("RGB", (3000, 1500), (10, 20, 30)).save(p)
    a, b = preprocess(p, 1024, 90), preprocess(p, 1024, 90)
    assert a == b
    from io import BytesIO

    assert Image.open(BytesIO(a)).size == (1024, 512)


def test_embeds_each_image_and_caches(tmp_path, images):
    fc = FakeClient()
    b = _backend(tmp_path, fc)
    st = EmbedStats()
    v = b.embed_paths(images + images[:1], budget=RequestBudget(3), stats=st)
    assert v.shape == (4, 128) and np.allclose(np.linalg.norm(v, axis=1), 1)
    assert np.allclose(v[0], v[3]) and len(fc.calls) == 3 == st.api_requests
    assert fc.calls == [128, 128, 128]
    st2 = EmbedStats()
    b.embed_paths(images, budget=RequestBudget(0), stats=st2)
    assert st2.cache_hits == 3 and len(fc.calls) == 3


def test_limit_checked_before_sending(tmp_path, images):
    fc = FakeClient()
    with pytest.raises(RequestLimitExceeded):
        _backend(tmp_path, fc).embed_paths(images, budget=RequestBudget(2), stats=EmbedStats())
    assert fc.calls == []


def test_retries_transient_then_succeeds(tmp_path, images):
    fc = FakeClient(errors=[429, 503])
    st, bud = EmbedStats(), RequestBudget(1)
    b = _backend(tmp_path, fc, concurrency=1)
    b.embed_paths(images[:1], budget=bud, stats=st)
    assert st.retries == 2 and bud.retries == 2 and len(fc.calls) == 3 and st.failed == []


def test_fatal_error_stops_further_requests(tmp_path, images):
    fc = FakeClient(errors=[403])
    st = EmbedStats()
    with pytest.raises(EmbeddingFailed):
        _backend(tmp_path, fc, concurrency=1).embed_paths(images, budget=RequestBudget(3), stats=st)
    assert len(fc.calls) == 1 and len(st.failed) == 3
