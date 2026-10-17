"""Public discovery privacy and real session/CSRF boundaries, with no Google calls."""

import uuid
from urllib.parse import parse_qs, urlsplit

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone
from maps.models import (
    Asset,
    Building,
    Contribution,
    Floor,
    MapTarget,
    Publication,
    Review,
    Revision,
    RevisionArtifact,
)
from rest_framework.test import APIClient

pytestmark = pytest.mark.django_db


def publish(user, *, coordinates=True, building=None):
    building = building or Building.objects.create(
        name="Published building",
        slug=uuid.uuid4().hex,
        created_by=user,
        latitude="43.653200" if coordinates else None,
        longitude="-79.383200" if coordinates else None,
    )
    floor_number = building.floors.count() + 1
    floor = Floor.objects.create(
        building=building,
        code=str(floor_number),
        name=f"Floor {floor_number}",
        sort_order=floor_number,
    )
    target = MapTarget.objects.create(floor=floor, title="Private instructions", created_by=user)
    contribution = Contribution.objects.create(target=target, author=user, title="Draft")
    revision = Revision.objects.create(
        target=target,
        contribution=contribution,
        created_by=user,
        geometry={"private_draft": "never-disclose"},
        content_hash="a" * 64,
        frozen_at=timezone.now(),
    )
    Contribution.objects.filter(pk=contribution.pk).update(
        head_revision=revision, status="submitted"
    )
    review = Review.objects.create(revision=revision, reviewer=user, decision="approved")
    asset = Asset.objects.create(
        target=target,
        uploaded_by=user,
        kind="svg",
        storage_key=uuid.uuid4().hex,
        content_type="image/svg+xml",
        sha256="a" * 64,
        byte_size=10,
    )
    RevisionArtifact.objects.create(
        revision=revision,
        kind="svg",
        state="ready",
        asset=asset,
        input_content_hash="a" * 64,
    )
    return Publication.objects.create(
        target=target,
        revision=revision,
        approval=review,
        published_by=user,
        sequence=1,
        is_current=True,
    )


def test_config_is_an_explicit_browser_allowlist(settings):
    settings.PUBLIC_GOOGLE_MAPS_BROWSER_API_KEY = "synthetic-browser-key"
    settings.GOOGLE_MAPS_MAP_ID = "DEMO_MAP_ID"
    settings.SOCIALACCOUNT_PROVIDERS = {
        "google": {"APP": {"client_id": "private-client", "secret": "never-send-secret"}}
    }
    response = APIClient().get("/api/client-config/")
    assert response.status_code == 200
    assert response.json() == {
        "maps": {"browser_key": "synthetic-browser-key", "map_id": "DEMO_MAP_ID"},
        "auth": {"google_enabled": True},
    }
    assert "no-store" in response["Cache-Control"]
    assert "never-send-secret" not in response.content.decode()
    assert "private-client" not in response.content.decode()


def test_discovery_hides_drafts_archived_invalid_and_unlocated_buildings():
    user = get_user_model().objects.create_user(username="publisher")
    visible = publish(user)
    publish(user, building=visible.target.floor.building)
    missing = publish(user, coordinates=False)
    invalid = publish(user)
    Publication.objects.filter(pk=invalid.pk).update(
        is_current=False, invalidated_at=timezone.now(), invalidation_reason="withdrawn"
    )
    archived = publish(user)
    MapTarget.objects.filter(pk=archived.target_id).update(
        status="archived", archived_at=timezone.now()
    )
    draft = publish(user)
    Publication.objects.filter(pk=draft.pk).update(is_current=False)
    response = APIClient().get("/api/maps/public/buildings/")
    assert response.status_code == 200
    buildings = response.json()["buildings"]
    assert len(buildings) == 1
    assert buildings[0]["id"] == str(visible.target.floor.building_id)
    assert buildings[0]["latitude"] == 43.6532
    assert len(buildings[0]["floors"]) == 2
    assert [floor["code"] for floor in buildings[0]["floors"]] == ["1", "2"]
    assert buildings[0]["floors"][0]["target_id"] == str(visible.target_id)
    assert "never-disclose" not in response.content.decode()
    assert str(missing.target.floor.building_id) not in response.content.decode()


def test_session_get_bootstraps_csrf_and_logout_requires_it():
    user = get_user_model().objects.create_user(username="session-user")
    client = APIClient(enforce_csrf_checks=True)
    client.force_login(user)
    response = client.get("/api/auth/me/")
    assert response.json()["authenticated"] is True
    assert "no-store" in response["Cache-Control"]
    token = client.cookies["XSRF-TOKEN"].value
    assert client.post("/api/auth/logout/", {}).status_code == 403
    response = client.post("/api/auth/logout/", {}, HTTP_X_XSRF_TOKEN=token)
    assert response.status_code == 200
    assert client.get("/api/auth/me/").json() == {"authenticated": False}


def test_frontend_oauth_post_preserves_local_return_without_following_google(settings):
    settings.SOCIALACCOUNT_PROVIDERS = {
        "google": {
            "APP": {"client_id": "synthetic-client", "secret": "synthetic-secret", "key": ""},
            "SCOPE": ["openid", "email", "profile"],
            "OAUTH_PKCE_ENABLED": True,
        }
    }
    client = APIClient(enforce_csrf_checks=True)
    client.get("/api/auth/me/", HTTP_HOST="127.0.0.1:4200")
    response = client.post(
        "/accounts/google/login/",
        {
            "csrfmiddlewaretoken": client.cookies["XSRF-TOKEN"].value,
            "next": "/auth/complete?returnUrl=%2Fgraph-editor",
        },
        format="multipart",
        HTTP_HOST="127.0.0.1:4200",
    )
    assert response.status_code == 302
    location = urlsplit(response["Location"])
    query = parse_qs(location.query)
    assert location.hostname == "accounts.google.com"
    assert query["redirect_uri"] == ["http://127.0.0.1:4200/accounts/google/login/callback/"]
    assert query["code_challenge_method"] == ["S256"]
    assert query["state"]


def test_backend_rejects_external_post_login_redirect():
    from accounts.adapters import AccountAdapter
    from allauth.core.context import request_context
    from django.test import RequestFactory

    request = RequestFactory().get("/", HTTP_HOST="127.0.0.1:4200")
    adapter = AccountAdapter(request)
    with request_context(request):
        assert not adapter.is_safe_url("https://attacker.invalid/")
        assert adapter.is_safe_url("/auth/complete?returnUrl=%2Fmap")


def test_authentication_error_page_has_recovery_without_private_error_details():
    from django.template.loader import render_to_string

    page = render_to_string(
        "socialaccount/authentication_error.html", {"exception": "never-show-token"}
    )
    assert 'href="/welcome"' in page
    assert "never-show-token" not in page
