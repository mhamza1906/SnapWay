"""Visitor session create + first-localize route plan (stable_id vs Node PK)."""

from __future__ import annotations

import io
import json
import uuid

import pytest
from django.contrib.auth import get_user_model
from django.core.files.uploadedfile import SimpleUploadedFile
from maps.models import Asset, Edge, MapObject, Node, Revision, RevisionArtifact, Room
from maps.services.index_catalog import set_key_for_revision
from navigation.models import RoutePlan
from navigation.services import placematch
from navigation.services.placematch import EngineResponse
from PIL import Image
from rest_framework.test import APIClient
from test_google_integration import publish

pytestmark = pytest.mark.django_db

ENGINE = {"PLACEMATCH_ENGINE_URL": "http://127.0.0.1:8790", "PLACEMATCH_ENGINE_TOKEN": "e" * 32}


def _jpeg() -> bytes:
    out = io.BytesIO()
    Image.new("RGB", (32, 24), (10, 20, 30)).save(out, "JPEG")
    return out.getvalue()


def _published_route_graph(user):
    """Two room nodes linked by a junction; destination is room B (stable_id for public API)."""

    state = {}

    def populate(revision):
        room_a = Room.objects.create(
            revision=revision,
            map_object=MapObject.objects.create(revision=revision, kind="room"),
            number="101",
            name="Start room",
        )
        room_b = Room.objects.create(
            revision=revision,
            map_object=MapObject.objects.create(revision=revision, kind="room"),
            number="202",
            name="Dest room",
        )
        start = Node.objects.create(
            revision=revision,
            kind=Node.Kind.ROOM,
            room=room_a,
            x=0,
            y=0,
            label="101",
            stable_id=uuid.uuid4(),
        )
        mid = Node.objects.create(
            revision=revision,
            kind=Node.Kind.JUNCTION,
            x=10,
            y=0,
            label="Hall",
            stable_id=uuid.uuid4(),
        )
        dest = Node.objects.create(
            revision=revision,
            kind=Node.Kind.ROOM,
            room=room_b,
            x=20,
            y=0,
            label="202",
            stable_id=uuid.uuid4(),
        )
        Edge.objects.create(
            revision=revision,
            from_node=start,
            to_node=mid,
            cost=1,
            distance_metres=10,
            is_open=True,
        )
        Edge.objects.create(
            revision=revision, from_node=mid, to_node=dest, cost=1, distance_metres=10, is_open=True
        )
        state["start"] = start
        state["dest"] = dest
        state["mid"] = mid

    publication = publish(user, populate_revision=populate)
    return publication, state["start"], state["dest"]


@pytest.fixture
def published_pair(db):
    user = get_user_model().objects.create_user(username="nav-pub")
    return _published_route_graph(user)


def test_session_create_resolves_stable_id_to_node_pk(published_pair):
    publication, start, dest = published_pair
    assert str(dest.stable_id) != str(dest.id)
    client = APIClient()
    response = client.post(
        "/api/navigation/sessions/",
        {"publication_id": str(publication.id), "destination_stable_id": str(dest.stable_id)},
        format="json",
    )
    assert response.status_code == 201, response.content
    body = response.json()
    assert body["destination_stable_id"] == str(dest.stable_id)
    assert body["destination_node_id"] == str(dest.id)
    assert body["secret"]
    assert body["session_id"]


def test_session_rejects_unknown_stable_id(published_pair):
    publication, _start, _dest = published_pair
    response = APIClient().post(
        "/api/navigation/sessions/",
        {"publication_id": str(publication.id), "destination_stable_id": str(uuid.uuid4())},
        format="json",
    )
    assert response.status_code == 400
    assert response.json()["error"] == "unknown_destination"


def test_session_rejects_node_pk_used_as_stable_id(published_pair):
    """ID mismatch: passing Node.id where stable_id is required must not silently match."""
    publication, _start, dest = published_pair
    response = APIClient().post(
        "/api/navigation/sessions/",
        {"publication_id": str(publication.id), "destination_stable_id": str(dest.id)},
        format="json",
    )
    assert response.status_code == 400
    assert response.json()["error"] == "unknown_destination"


@pytest.fixture
def indexed_publication(published_pair, settings, tmp_path, monkeypatch):
    publication, start, dest = published_pair
    settings.MEDIA_ROOT = tmp_path
    settings.DEBUG = True
    for key, value in ENGINE.items():
        setattr(settings, key, value)
    settings.ROUTE_GEMINI_REWRITE = False

    import hashlib

    from maps.services.media_store import put_bytes

    revision = Revision.objects.get(pk=publication.revision_id)
    raw = b"FAKEZIP"
    digest = hashlib.sha256(raw).hexdigest()
    key = f"indexes/{revision.target_id}/{revision.id}/test.zip"
    put_bytes(key, raw, "application/zip")
    asset = Asset.objects.create(
        target=revision.target,
        uploaded_by=revision.created_by,
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

    match = {
        "decision": {
            "outcome": "likely_match",
            "location_id": str(start.id),
            "node_id": str(start.id),
            "revision_id": str(revision.id),
            "target_id": str(revision.target_id),
            "reasons": [],
        },
        "candidates": [],
        "backend_used": "megaloc",
        "timings_ms": {"total": 1},
    }

    def fake_send(request):
        url = request.full_url
        if url.endswith("/v1/catalog") and request.get_method() == "GET":
            return EngineResponse(
                200,
                "application/json",
                json.dumps({"api_version": "v1", "sets": [], "n_vectors": 0}).encode(),
            )
        if "/v1/catalog/sync" in url:
            return EngineResponse(
                200,
                "application/json",
                json.dumps(
                    {
                        "api_version": "v1",
                        "sets": [
                            {
                                "set_key": set_key_for_revision(revision),
                                "content_hash": "x",
                                "revision_id": str(revision.id),
                                "target_id": str(revision.target_id),
                                "n_vectors": 1,
                            }
                        ],
                        "n_vectors": 1,
                    }
                ).encode(),
            )
        if "/v1/match-global" in url:
            return EngineResponse(200, "application/json", json.dumps(match).encode())
        return EngineResponse(404, "application/json", b"{}")

    monkeypatch.setattr(placematch, "_send", fake_send)
    return publication, start, dest, match


def test_first_localize_builds_route_once(indexed_publication):
    publication, start, dest, _match = indexed_publication
    client = APIClient()
    created = client.post(
        "/api/navigation/sessions/",
        {"publication_id": str(publication.id), "destination_stable_id": str(dest.stable_id)},
        format="json",
    ).json()
    secret = created["secret"]
    assert created["destination_node_id"] == str(dest.id)
    assert created["destination_stable_id"] == str(dest.stable_id)
    # MegaLoc location_id is Node PK — different string from destination stable_id.
    assert str(start.id) != str(dest.stable_id)

    def localize():
        return client.post(
            "/api/navigation/localize/",
            {
                "image": SimpleUploadedFile("f.jpg", _jpeg(), content_type="image/jpeg"),
                "meta": json.dumps({"client_frame_id": 1, "timestamp_s": 1.0}),
            },
            format="multipart",
            HTTP_AUTHORIZATION=f"Navigation {secret}",
        )

    first = localize()
    assert first.status_code == 200, first.content
    body = first.json()
    assert body["node_id"] == str(start.id)
    assert body["node_stable_id"] == str(start.stable_id)
    assert body["destination_stable_id"] == str(dest.stable_id)
    assert body["destination_node_id"] == str(dest.id)
    route = body["route"]
    assert route and route["ok"]
    assert route["start_node_id"] == str(start.id)
    assert route["destination_stable_id"] == str(dest.stable_id)
    assert len(route["steps"]) == 2
    assert RoutePlan.objects.filter(session_id=created["session_id"]).count() == 1

    second = localize()
    assert second.status_code == 200
    assert second.json()["route"]["route_plan_id"] == route["route_plan_id"]
    assert RoutePlan.objects.filter(session_id=created["session_id"]).count() == 1

    current = client.get(
        "/api/navigation/sessions/current/route/",
        HTTP_AUTHORIZATION=f"Navigation {secret}",
    )
    assert current.status_code == 200
    assert current.json()["route"]["route_plan_id"] == route["route_plan_id"]


def test_localize_without_session_has_null_route(indexed_publication, settings):
    _publication, _start, _dest, _match = indexed_publication
    settings.PLACEMATCH_DEV_TOKEN = "d" * 32
    settings.DEBUG = True
    client = APIClient()
    response = client.post(
        "/api/navigation/localize/",
        {
            "image": SimpleUploadedFile("f.jpg", _jpeg(), content_type="image/jpeg"),
            "meta": json.dumps({"client_frame_id": 1, "timestamp_s": 1.0}),
        },
        format="multipart",
        HTTP_AUTHORIZATION="Bearer " + "d" * 32,
    )
    assert response.status_code == 200
    assert response.json()["route"] is None
