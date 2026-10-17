import io
import json

import pytest
from django.contrib.auth import get_user_model
from navigation import authentication
from navigation.models import NavigationSession
from navigation.services import placematch
from navigation.services.placematch import EngineError, EngineResponse
from PIL import Image
from rest_framework.test import APIClient

User = get_user_model()
DEV_TOKEN = "d" * 32
ENGINE = {"PLACEMATCH_ENGINE_URL": "http://127.0.0.1:8790", "PLACEMATCH_ENGINE_TOKEN": "e" * 32}
MATCH = {
    "decision": {"outcome": "likely_match", "location_id": "hall", "reasons": []},
    "candidates": [{"rank": 1, "reference_id": "r", "location_id": "hall", "cosine": 0.4}],
    "backend_used": "megaloc",
    "fallback_used": False,
    "thresholds_id": "sha256:x",
}


def _jpeg(size=(32, 24)) -> bytes:
    out = io.BytesIO()
    Image.new("RGB", size, (90, 90, 90)).save(out, "JPEG")
    return out.getvalue()


def _upload(client, data=None, ctype="image/jpeg", meta=None, query=""):
    from django.core.files.uploadedfile import SimpleUploadedFile

    meta = {"client_frame_id": 3, "timestamp_s": 1.0} if meta is None else meta
    # Existing engine-forward tests use the legacy single-set match path.
    if query and not query.startswith("?"):
        query = "?" + query
    if "mode=" not in query:
        query = ("?mode=legacy" if not query else query + "&mode=legacy")
    return client.post(
        "/api/navigation/localize/" + query,
        {
            "image": SimpleUploadedFile("f.jpg", data or _jpeg(), content_type=ctype),
            "meta": json.dumps(meta),
        },
        format="multipart",
    )


@pytest.fixture
def engine(monkeypatch, settings):
    for key, value in ENGINE.items():
        setattr(settings, key, value)
    calls = []

    def fake_send(request):
        calls.append(request)
        if request.full_url.startswith(ENGINE["PLACEMATCH_ENGINE_URL"] + "/v1/match"):
            return EngineResponse(200, "application/json", json.dumps(MATCH).encode())
        if "/thumb/" in request.full_url:
            return EngineResponse(200, "image/jpeg", b"\xff\xd8jpeg")
        return EngineResponse(200, "application/json", b'{"api_version": "v1"}')

    monkeypatch.setattr(placematch, "_send", fake_send)
    return calls


@pytest.fixture
def user_client(db):
    client = APIClient()
    client.force_authenticate(User.objects.create_user(username="v", password="x"))
    return client


@pytest.mark.django_db
def test_anonymous_and_bearer_without_debug_are_rejected(engine, settings):
    client = APIClient()
    assert client.get("/api/navigation/localize/health/").status_code in (401, 403)
    settings.PLACEMATCH_DEV_TOKEN = DEV_TOKEN
    settings.DEBUG = False
    client.credentials(HTTP_AUTHORIZATION=f"Bearer {DEV_TOKEN}")
    assert client.get("/api/navigation/localize/health/").status_code == 401


@pytest.mark.django_db
def test_dev_token_works_only_in_debug(engine, settings):
    settings.PLACEMATCH_DEV_TOKEN = DEV_TOKEN
    settings.DEBUG = True
    client = APIClient()
    client.credentials(HTTP_AUTHORIZATION="Bearer wrong-token-value-xxxxxxxxxxxx")
    assert client.get("/api/navigation/localize/health/").status_code == 401
    client.credentials(HTTP_AUTHORIZATION=f"Bearer {DEV_TOKEN}")
    r = client.get("/api/navigation/localize/health/")
    assert r.status_code == 200 and r.json()["caller"] == "dev_token"


@pytest.mark.django_db
def test_navigation_session_capability(engine, monkeypatch):
    seen = []

    def fake_active(secret):
        seen.append(secret)
        return NavigationSession() if secret == "visitor-secret" else None

    monkeypatch.setattr(authentication, "active_session", fake_active)
    client = APIClient()
    client.credentials(HTTP_AUTHORIZATION="Navigation nope")
    assert client.get("/api/navigation/localize/health/").status_code == 401
    client.credentials(HTTP_AUTHORIZATION="Navigation visitor-secret")
    r = client.get("/api/navigation/localize/health/")
    assert r.status_code == 200 and r.json()["caller"] == "navigation_session"
    assert authentication.token_digest("visitor-secret") != "visitor-secret"


def test_forwards_frame_and_meta_and_passes_decision_through(engine, user_client):
    r = _upload(user_client, query="?backend=auto&second_opinion=true")
    assert r.status_code == 200
    body = r.json()
    assert body["decision"]["outcome"] == "likely_match" and body["caller"] == "user"
    sent = engine[-1]
    assert "backend=auto" in sent.full_url and "second_opinion=true" in sent.full_url
    assert b'"client_frame_id": 3' in sent.data and b"\xff\xd8" in sent.data
    assert sent.get_header("Content-type").startswith("multipart/form-data; boundary=")


def test_rejects_bad_frames_and_meta(engine, user_client):
    png = io.BytesIO()
    Image.new("RGB", (8, 8)).save(png, "PNG")
    assert _upload(user_client, data=png.getvalue(), ctype="image/png").status_code == 415
    assert _upload(user_client, data=png.getvalue()).status_code in (400, 415)
    assert _upload(user_client, data=_jpeg((4200, 8))).status_code == 413
    assert _upload(user_client, meta={"client_frame_id": -1}).status_code == 400
    assert _upload(user_client, meta={"client_frame_id": 1, "x": 1}).status_code == 400
    assert _upload(user_client, query="?backend=gpt").status_code == 400
    assert not [c for c in engine if "/v1/match" in c.full_url]


def test_engine_errors_and_missing_configuration(monkeypatch, settings, user_client):
    settings.PLACEMATCH_ENGINE_URL = ""
    r = user_client.get("/api/navigation/localize/health/")
    assert r.status_code == 503 and r.json()["error"] == "not_configured"
    for key, value in ENGINE.items():
        setattr(settings, key, value)

    def busy(request):
        raise EngineError(503, "engine_rejected", "no matching backend available")

    monkeypatch.setattr(placematch, "_send", busy)
    r = _upload(user_client)
    assert r.status_code == 503 and "no matching backend" in r.json()["detail"]


def test_thumbnail_passthrough(engine, user_client):
    r = user_client.get("/api/navigation/localize/references/demo/thumb/reference:hall/a.jpg")
    assert r.status_code == 200 and r["Content-Type"] == "image/jpeg"
    assert "/v1/references/demo/thumb/reference:hall/a.jpg" in engine[-1].full_url
