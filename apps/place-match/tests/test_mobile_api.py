"""Mobile API and MegaLoc-first decision rules, offline (fake backends, no models)."""

from __future__ import annotations

import io
import json
from pathlib import Path

import numpy as np
import pytest
from fastapi.testclient import TestClient
from PIL import Image

from placematch.backends.base import EmbeddingIndex, l2_normalize
from placematch.mobile_api import BackendSlot, MobileEngine, MobileSettings, create_app
from placematch.mobile_decide import BackendOutcome, NoBackendAvailable, combine, decide_backend
from placematch.reference_sets import ReferenceSet
from placematch.schemas import (
    BackendThresholds,
    Candidate,
    Decision,
    Manifest,
    ManifestEntry,
    ThresholdSet,
    VerificationResult,
    VerifyThresholds,
)

TOKEN = "t" * 32
AUTH = {"Authorization": f"Bearer {TOKEN}"}
VERIFY_TH = VerifyThresholds(min_inliers=40, min_inlier_ratio=0.3, min_coverage=0.12)
COLOURS = {"hall": (220, 40, 40), "lab": (40, 220, 40), "stairs": (40, 40, 220)}


class FakeBackend:
    """3-d vector = normalised mean RGB; deterministic and model-free."""

    def __init__(self, key: str, remote: bool = False, fail: bool = False):
        self.key, self.remote, self.fail = key, remote, fail

    def embed_paths(self, paths, *, budget, stats):
        if self.fail:
            raise RuntimeError("model not loaded")
        if self.remote:
            budget.take(len(paths))
        rows = [
            np.asarray(Image.open(p).convert("RGB"), dtype=np.float32).mean((0, 1)) for p in paths
        ]
        return l2_normalize(np.stack(rows))

    def config(self) -> dict:
        return {"provider": "fake"}


def _jpeg(colour, size=(64, 48)) -> bytes:
    out = io.BytesIO()
    Image.new("RGB", size, colour).save(out, "JPEG", quality=90)
    return out.getvalue()


def _thresholds() -> ThresholdSet:
    return ThresholdSet(
        calibrated_on="fake:validation",
        method="test",
        backends={
            "megaloc:fake": BackendThresholds(
                accept_cosine=0.95, reject_cosine=0.5, min_margin=0.01, verify=VERIFY_TH
            ),
            "vertex:fake": BackendThresholds(
                accept_cosine=0.95, reject_cosine=0.5, min_margin=0.0, verify=VERIFY_TH
            ),
        },
    )


def _verified(ok=True) -> VerificationResult:
    return VerificationResult(
        status="verified" if ok else "inconclusive",
        n_inliers=200 if ok else 2,
        inlier_ratio=0.8 if ok else 0.05,
        coverage_query=0.5 if ok else 0.0,
        coverage_reference=0.5 if ok else 0.0,
    )


@pytest.fixture
def ref_set(tmp_path: Path) -> ReferenceSet:
    directory = tmp_path / "references" / "demo"
    entries = []
    for loc, colour in COLOURS.items():
        (directory / "images" / loc).mkdir(parents=True)
        path = directory / "images" / loc / "a.jpg"
        path.write_bytes(_jpeg(colour))
        entries.append(
            ManifestEntry(
                image_id=f"reference:{loc}/a.jpg",
                path=str(path),
                role="reference",
                dataset="user",
                scene_id="images",
                location_id=loc,
            )
        )
    manifest = Manifest(name="references:demo", entries=entries)
    (directory / "manifest.json").write_text(manifest.model_dump_json(), encoding="utf-8")
    return ReferenceSet.load("demo", tmp_path / "references")


def _slot(name, key, ref_set, *, remote=False, fail=False, index=True):
    backend = FakeBackend(key, remote=remote, fail=fail)
    ids = list(ref_set.by_id)
    idx = None
    if index:
        vecs = backend if not fail else FakeBackend(key)
        idx = EmbeddingIndex(
            key,
            ids,
            vecs.embed_paths([ref_set.image_path(i) for i in ids], budget=_B(), stats=None),
        )
    return BackendSlot(name, backend, idx)


class _B:
    def take(self, n=1):
        pass


def _client(ref_set, *, megaloc_fail=False, vertex=True, verify_ok=True, rate=60):
    slots = {"megaloc": _slot("megaloc", "megaloc:fake", ref_set, fail=megaloc_fail)}
    if vertex:
        slots["vertex"] = _slot("vertex", "vertex:fake", ref_set, remote=True)
    engine = MobileEngine(
        reference_set=ref_set,
        thresholds=_thresholds(),
        thresholds_id="sha256:test",
        slots=slots,
        verify_fn=lambda q, r, th: _verified(verify_ok),
    )
    app = create_app(
        engine, MobileSettings(token=TOKEN, reference_set="demo", rate_per_minute=rate)
    )
    return TestClient(app)


def _post(client, colour=(220, 40, 40), query="", meta=None, ctype="image/jpeg", data=None):
    meta = meta or {"client_frame_id": 7, "timestamp_s": 1.5, "orientation": "portrait"}
    return client.post(
        "/v1/match" + query,
        headers=AUTH,
        files={"image": ("f.jpg", data if data is not None else _jpeg(colour), ctype)},
        data={"meta": json.dumps(meta)},
    )


# ---------------------------------------------------------------- decision rules (pure)


def _cands(*rows):
    return [
        Candidate(rank=i + 1, reference_id=r, location_id=loc, cosine=c)
        for i, (r, loc, c) in enumerate(rows)
    ]


def _outcome(name, key, cands, outcome, ref=None, verified=None):
    if verified is not None:
        cands[0].verification = _verified(verified)
    return BackendOutcome(name, key, cands, Decision(outcome=outcome, reference_id=ref))


def test_megaloc_decision_is_authoritative_and_not_combined():
    m = _outcome("megaloc", "megaloc:fake", _cands(("r1", "hall", 0.99)), "likely_match", "r1")
    v = _outcome("vertex", "vertex:fake", _cands(("r2", "lab", 0.99)), "likely_match", "r2", True)
    c = combine("auto", m, v)
    assert c.decision.outcome == "likely_match" and c.decision.reference_id == "r1"
    assert c.backend_used == "megaloc" and not c.fallback_used and not c.second_opinion_used


def test_second_opinion_confirms_only_same_location_with_verification():
    m = _outcome(
        "megaloc", "megaloc:fake", _cands(("r1", "hall", 0.9), ("r9", "lab", 0.8)), "uncertain"
    )
    same = _outcome(
        "vertex", "vertex:fake", _cands(("r3", "hall", 0.97)), "likely_match", "r3", True
    )
    c = combine("auto", m, same)
    assert c.decision.outcome == "likely_match" and c.location_id == "hall"
    assert c.backend_used == "megaloc+vertex" and c.second_opinion_used
    other = _outcome(
        "vertex", "vertex:fake", _cands(("r4", "lab", 0.97)), "likely_match", "r4", True
    )
    assert combine("auto", m, other).decision.outcome == "uncertain"


def test_vertex_never_accepts_without_verification():
    cands = _cands(("reference:hall/a.jpg", "hall", 0.99), ("reference:lab/a.jpg", "lab", 0.3))
    d = decide_backend("vertex", "vertex:fake", cands, _thresholds(), verification_ran=False)
    assert d.outcome == "uncertain"
    assert any("verification" in r for r in d.reasons)


def test_vertex_fallback_when_megaloc_unavailable():
    m = BackendOutcome("megaloc", None, error="model not loaded")
    v = _outcome("vertex", "vertex:fake", _cands(("r3", "hall", 0.97)), "likely_match", "r3", True)
    c = combine("auto", m, v)
    assert c.fallback_used and c.backend_used == "vertex"
    with pytest.raises(NoBackendAvailable):
        combine("auto", m, None)


# ---------------------------------------------------------------- HTTP API


def test_every_endpoint_requires_the_token(ref_set):
    client = _client(ref_set)
    assert client.get("/v1/health").status_code == 401
    bad = {"Authorization": "Bearer nope"}
    assert client.get("/v1/health", headers=bad).status_code == 401
    assert client.get("/v1/references/demo/thumb/reference:hall/a.jpg").status_code == 401
    body = client.get("/v1/health", headers=AUTH).json()
    assert body["backends"]["megaloc"]["ready"] and body["thresholds_id"] == "sha256:test"
    assert TOKEN not in json.dumps(body)


def test_match_megaloc_first_reports_backend_and_raw_cosines(ref_set):
    r = _post(_client(ref_set), (220, 40, 40))
    assert r.status_code == 200
    body = r.json()
    assert body["decision"]["outcome"] == "likely_match"
    assert body["decision"]["location_id"] == "hall"
    assert body["backend_used"] == "megaloc" and body["fallback_used"] is False
    assert body["candidates"][0]["cosine"] <= 1.0 and "%" not in json.dumps(body["candidates"])
    assert {"decode", "total"} <= set(body["timings_ms"]) and body["stored"] is False
    assert body["frame"]["client_frame_id"] == 7 and body["thresholds_id"] == "sha256:test"


def test_megaloc_unavailable_falls_back_to_vertex_needing_verification(ref_set):
    r = _post(_client(ref_set, megaloc_fail=True), (40, 220, 40))
    body = r.json()
    assert body["fallback_used"] and body["backend_used"] == "vertex"
    assert body["decision"]["outcome"] == "likely_match"  # fake verification passes
    r = _post(_client(ref_set, megaloc_fail=True, verify_ok=False), (40, 220, 40))
    assert r.json()["decision"]["outcome"] == "uncertain"


def test_no_backend_is_503_not_a_guess(ref_set):
    r = _post(_client(ref_set, megaloc_fail=True, vertex=False), (40, 220, 40))
    assert r.status_code == 503 and r.json()["error"] == "no_backend_available"


def test_rejects_non_jpeg_oversized_and_bad_meta(ref_set):
    client = _client(ref_set)
    png = io.BytesIO()
    Image.new("RGB", (8, 8)).save(png, "PNG")
    assert _post(client, data=png.getvalue(), ctype="image/png").status_code == 415
    assert _post(client, data=png.getvalue()).status_code == 415
    assert _post(client, data=_jpeg((1, 2, 3), (4100, 10))).status_code == 413
    assert _post(client, meta={"client_frame_id": -1}).status_code == 422
    assert _post(client, meta={"client_frame_id": 1, "token": "x"}).status_code == 422


def test_rate_limit(ref_set):
    client = _client(ref_set, rate=2)
    assert client.get("/v1/health", headers=AUTH).status_code == 200
    assert client.get("/v1/health", headers=AUTH).status_code == 200
    r = client.get("/v1/health", headers=AUTH)
    assert r.status_code == 429 and "Retry-After" in r.headers


def test_thumbnails_only_for_known_ids_and_index_export(ref_set):
    client = _client(ref_set)
    r = client.get("/v1/references/demo/thumb/reference:hall/a.jpg", headers=AUTH)
    assert r.status_code == 200 and r.headers["content-type"] == "image/jpeg"
    assert client.get("/v1/references/demo/thumb/../../etc/passwd", headers=AUTH).status_code == 404
    assert (
        client.get("/v1/references/other/thumb/reference:hall/a.jpg", headers=AUTH).status_code
        == 404
    )
    idx = client.get("/v1/references/demo/megaloc-index", headers=AUTH).json()
    assert idx["backend_key"] == "megaloc:fake" and idx["dtype"] == "float16"
    assert idx["shape"] == [3, 3] and len(idx["location_ids"]) == 3
