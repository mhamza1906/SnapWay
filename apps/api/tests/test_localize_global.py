"""Global multi-floor localize path (mocked place-match engine)."""

from __future__ import annotations

import io
import json

import pytest
from django.contrib.auth import get_user_model
from django.core.files.uploadedfile import SimpleUploadedFile
from maps.models import Asset, Revision, RevisionArtifact
from maps.services.draft import ensure_demo_draft
from maps.services.index_catalog import eligible_index_entries, set_key_for_revision
from navigation.services import placematch
from navigation.services.placematch import EngineResponse
from PIL import Image
from rest_framework.test import APIClient

User = get_user_model()
ENGINE = {"PLACEMATCH_ENGINE_URL": "http://127.0.0.1:8790", "PLACEMATCH_ENGINE_TOKEN": "e" * 32}


def _jpeg() -> bytes:
    out = io.BytesIO()
    Image.new("RGB", (32, 24), (10, 20, 30)).save(out, "JPEG")
    return out.getvalue()


@pytest.fixture
def member(db):
    return User.objects.create_user(username="loc", email="loc@example.com", password="x")


@pytest.fixture
def draft_with_index(member, settings, tmp_path):
    settings.MEDIA_ROOT = tmp_path
    settings.DEBUG = True
    draft = ensure_demo_draft(member)
    revision = Revision.objects.select_related("target").get(pk=draft["revision_id"])
    import hashlib

    from maps.services.media_store import put_bytes

    raw = b"FAKEZIP"
    digest = hashlib.sha256(raw).hexdigest()
    key = f"indexes/{revision.target_id}/{revision.id}/test.zip"
    put_bytes(key, raw, "application/zip")
    asset = Asset.objects.create(
        target=revision.target,
        uploaded_by=member,
        kind=Asset.Kind.INDEX,
        storage_key=key,
        content_type="application/zip",
        sha256=digest,
        byte_size=len(raw),
    )
    RevisionArtifact.objects.create(
        revision=revision,
        kind="index",
        state=RevisionArtifact.State.READY,
        required=True,
        asset=asset,
        input_content_hash="a" * 64,
        profile={"backend_name": "megaloc"},
    )
    return draft, revision


@pytest.fixture
def global_engine(monkeypatch, settings):
    for key, value in ENGINE.items():
        setattr(settings, key, value)
    state = {"catalog": {"sets": [], "n_vectors": 0}, "synced": None}

    def fake_send(request):
        url = request.full_url
        if url.endswith("/v1/catalog") and request.get_method() == "GET":
            return EngineResponse(
                200,
                "application/json",
                json.dumps({"api_version": "v1", **state["catalog"]}).encode(),
            )
        if "/v1/catalog/sync" in url:
            # Minimal: mark empty remote as synced for whatever was sent.
            state["synced"] = True
            state["catalog"] = {
                "sets": [
                    {
                        "set_key": "synced",
                        "content_hash": "x",
                        "revision_id": "r",
                        "target_id": "t",
                        "n_vectors": 1,
                    }
                ],
                "n_vectors": 1,
            }
            return EngineResponse(
                200,
                "application/json",
                json.dumps({"api_version": "v1", **state["catalog"]}).encode(),
            )
        if "/v1/match-global" in url:
            body = {
                "api_version": "v1",
                "mode": "global_catalog",
                "decision": {
                    "outcome": "likely_match",
                    "reference_id": "reference:n/a.jpg",
                    "location_id": "node-1",
                    "node_id": "node-1",
                    "revision_id": state.get("revision_id", "rev"),
                    "target_id": state.get("target_id", "tgt"),
                    "reasons": ["ok"],
                },
                "candidates": [],
                "backend_used": "megaloc",
            }
            return EngineResponse(200, "application/json", json.dumps(body).encode())
        if url.endswith("/v1/health"):
            return EngineResponse(200, "application/json", b'{"api_version":"v1"}')
        raise AssertionError(f"unexpected engine URL {url}")

    monkeypatch.setattr(placematch, "_send", fake_send)
    return state


@pytest.mark.django_db
def test_eligible_includes_debug_draft(draft_with_index, settings):
    settings.DEBUG = True
    _draft, revision = draft_with_index
    entries = eligible_index_entries()
    assert any(e.revision_id == str(revision.id) for e in entries)
    settings.DEBUG = False
    assert eligible_index_entries() == []


@pytest.mark.django_db
def test_global_localize_enriches_floor(draft_with_index, global_engine, member):
    draft, revision = draft_with_index
    global_engine["revision_id"] = str(revision.id)
    global_engine["target_id"] = str(revision.target_id)
    # After sync, force match-global to use real ids from decision override in fixture —
    # patch ensure to set catalog hashes equal so sync may still upload once.
    client = APIClient()
    client.force_login(member)
    r = client.post(
        "/api/navigation/localize/",
        {
            "image": SimpleUploadedFile("f.jpg", _jpeg(), content_type="image/jpeg"),
            "meta": json.dumps({"client_frame_id": 1}),
        },
        format="multipart",
    )
    assert r.status_code == 200, r.content
    body = r.json()
    assert body["decision"]["outcome"] == "likely_match"
    assert body["target_id"] == str(revision.target_id)
    assert body["floor_id"]
    assert body["building_id"]
    assert body["caller"] == "user"


@pytest.mark.django_db
def test_global_empty_catalog_503(member, global_engine, settings):
    settings.DEBUG = True
    client = APIClient()
    client.force_login(member)
    # No artifacts → empty catalog
    r = client.post(
        "/api/navigation/localize/",
        {
            "image": SimpleUploadedFile("f.jpg", _jpeg(), content_type="image/jpeg"),
            "meta": json.dumps({"client_frame_id": 1}),
        },
        format="multipart",
    )
    assert r.status_code == 503
    assert r.json()["error"] == "index_not_ready"


@pytest.mark.django_db
def test_set_key_stable():
    assert set_key_for_revision("0dacc7d3-bb06-4b72-8c35-a869e5cdfd9f").startswith("rev_")
