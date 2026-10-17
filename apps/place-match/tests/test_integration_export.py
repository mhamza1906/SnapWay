"""Head-owned tests: exports, contracts and the web server's lookup rules (offline)."""

import csv

import numpy as np
import pytest
from fastapi.testclient import TestClient
from PIL import Image

from placematch import server
from placematch.backends.base import (
    EmbeddingIndex,
    RequestBudget,
    RequestLimitExceeded,
    l2_normalize,
)
from placematch.export import export_all, write_json
from placematch.schemas import (
    Candidate,
    Decision,
    Manifest,
    ManifestEntry,
    QueryResult,
    ReferenceResult,
    ReverseMatch,
    RunResult,
    RunStats,
    VerificationResult,
)


def make_run(tmp_path):
    for name, colour in (("q.jpg", (200, 10, 10)), ("r.jpg", (10, 200, 10))):
        Image.new("RGB", (32, 24), colour).save(tmp_path / name)
    manifest = Manifest(
        name="t",
        entries=[
            ManifestEntry(
                image_id="query:q", path="q.jpg", role="query", dataset="t", scene_id="s"
            ),
            ManifestEntry(
                image_id="reference:r",
                path="r.jpg",
                role="reference",
                dataset="t",
                scene_id="s",
                location_id="lobby",
            ),
        ],
    )
    mpath = write_json(manifest, tmp_path / "manifest.json")
    verification = VerificationResult(status="inconclusive", n_correspondences=12, n_inliers=3)
    run = RunResult(
        run_id="r1",
        created_utc="2026-10-17T00:00:00Z",
        backend="fake:1",
        backend_config={},
        manifest=str(mpath),
        queries=[
            QueryResult(
                query_id="query:q",
                path="q.jpg",
                timestamp_s=1.5,
                candidates=[
                    Candidate(
                        rank=1,
                        reference_id="reference:r",
                        location_id="lobby",
                        cosine=0.71234,
                        verification=verification,
                    )
                ],
                decision=Decision(outcome="uncertain", reasons=["test"], thresholds="uncalibrated"),
            )
        ],
        references=[
            ReferenceResult(
                reference_id="reference:r",
                location_id="lobby",
                best_queries=[ReverseMatch(query_id="query:q", cosine=0.71234, timestamp_s=1.5)],
            )
        ],
        stats=RunStats(
            n_references=1,
            n_queries=1,
            expected_uncached_requests=2,
            api_requests=2,
            cache_hits=0,
            cache_misses=2,
        ),
    )
    return run


def test_exports_keep_cosine_and_geometry_separate(tmp_path):
    run = make_run(tmp_path)
    files = export_all(run, tmp_path / "out")
    rows = list(csv.DictReader(open(files["csv"], encoding="utf-8")))
    assert rows[0]["cosine"] == "0.7123"
    assert rows[0]["verify_status"] == "inconclusive"
    assert rows[0]["inliers"] == "3"
    assert "%" not in "".join(rows[0].values())
    reverse = list(csv.DictReader(open(files["reverse_csv"], encoding="utf-8")))
    assert reverse[0]["timestamp_s"] == "1.500"
    assert RunResult.model_validate_json(open(files["json"]).read()).queries[0].timestamp_s == 1.5


def test_budget_and_index_guards(tmp_path):
    budget = RequestBudget(limit=2)
    budget.take(2)
    with pytest.raises(RequestLimitExceeded):
        budget.take()
    a = EmbeddingIndex("gemini:x", ["a"], l2_normalize(np.ones((1, 4))))
    b = EmbeddingIndex("megaloc:y", ["b"], l2_normalize(np.ones((1, 4))))
    with pytest.raises(ValueError):
        a.check_compatible(b)
    a.save(tmp_path / "idx")
    assert EmbeddingIndex.load(tmp_path / "idx").image_ids == ["a"]


def test_server_serves_only_manifest_images(tmp_path, monkeypatch):
    runs = tmp_path / "runs"
    run = make_run(tmp_path)
    export_all(run, runs / "demo" / "gemini")
    monkeypatch.setattr(server, "RUNS_DIR", runs)
    client = TestClient(server.app)
    listed = client.get("/api/runs").json()
    assert listed[0]["id"] == "demo/gemini"
    detail = client.get("/api/run", params={"id": "demo/gemini"}).json()
    assert detail["images"]["reference:r"]["location_id"] == "lobby"
    ok = client.get("/api/image", params={"id": "demo/gemini", "image_id": "reference:r"})
    assert ok.status_code == 200
    assert (
        client.get("/api/image", params={"id": "demo/gemini", "image_id": "x"}).status_code == 404
    )
    assert client.get("/api/run", params={"id": "../../etc"}).status_code == 404
    assert client.get("/api/export", params={"id": "demo/gemini", "kind": "csv"}).status_code == 200
