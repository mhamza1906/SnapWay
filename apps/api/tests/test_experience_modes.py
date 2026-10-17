"""Mode selection cannot grant authority or bypass the public-session boundary."""

from urllib.parse import parse_qs, urlsplit

import pytest
from accounts.adapters import AccountAdapter, SocialAccountAdapter
from allauth.core.context import request_context
from allauth.socialaccount.models import SocialLogin
from django.contrib.auth import get_user_model, logout
from django.core.exceptions import PermissionDenied
from django.test import RequestFactory
from maps.models import Membership
from maps.services.draft import ensure_demo_draft
from maps.services.membership import grant_membership
from rest_framework.test import APIClient

pytestmark = pytest.mark.django_db


def test_mode_switch_is_same_account_without_permission_escalation():
    user = get_user_model().objects.create_user(username="switcher")
    client = APIClient(enforce_csrf_checks=True)
    client.force_login(user)
    assert client.get("/api/auth/me/").json()["mode"] == "public"
    token = client.cookies["XSRF-TOKEN"].value
    assert client.post("/api/auth/mode/", {"mode": "developer"}).status_code == 403
    for payload in ({"mode": "admin"}, {"mode": "developer", "is_staff": True}):
        assert (
            client.post(
                "/api/auth/mode/", payload, format="json", HTTP_X_XSRF_TOKEN=token
            ).status_code
            == 400
        )
    selected = client.post(
        "/api/auth/mode/", {"mode": "developer"}, format="json", HTTP_X_XSRF_TOKEN=token
    ).json()
    assert selected["id"] == user.pk
    assert selected["mode"] == "developer"
    assert selected["can_admin"] is False
    assert selected["memberships"] == []
    user.refresh_from_db()
    assert not user.is_staff and not user.is_superuser
    assert not Membership.objects.filter(user=user).exists()


def test_public_mode_blocks_drafts_and_private_graph_even_for_an_admin():
    user = get_user_model().objects.create_user(username="operator", is_staff=True)
    draft = ensure_demo_draft(user)
    target_id = draft["target_id"]
    Membership.objects.filter(user=user, target_id=target_id).update(role="admin")
    client = APIClient()
    client.force_login(user)
    graph_url = f"/api/maps/revisions/{draft['revision_id']}/graph/"
    node_url = f"/api/maps/revisions/{draft['revision_id']}/nodes/"
    assert client.get(graph_url).status_code == 403
    assert client.post(node_url, {"x": 1, "y": 2}).status_code == 403
    assert client.post("/api/maps/drafts/ensure/", {}).status_code == 403
    public = client.get("/api/auth/me/").json()
    assert public["memberships"] == [] and not public["can_admin"]
    assert client.get("/api/maps/public/buildings/").status_code == 200
    developer = client.post("/api/auth/mode/", {"mode": "developer"}).json()
    assert developer["id"] == public["id"] and developer["can_admin"]
    assert client.get(graph_url).status_code == 200
    client.post("/api/auth/mode/", {"mode": "public"})
    assert client.get(graph_url).status_code == 403
    assert Membership.objects.get(user=user, target_id=target_id).role == "admin"


def test_new_draft_never_self_provisions_an_admin():
    user = get_user_model().objects.create_user(username="ordinary")
    draft = ensure_demo_draft(user)
    membership = Membership.objects.get(user=user, target_id=draft["target_id"])
    assert membership.role == "volunteer"
    membership.role = "admin"  # Represents explicit database provisioning by an operator.
    membership.save()
    another = get_user_model().objects.create_user(username="another")
    with pytest.raises(PermissionDenied, match="database-provisioned"):
        grant_membership(target=membership.target, user=another, role="admin", granted_by=user)


def test_anonymous_mode_switch_is_rejected_and_login_start_requires_csrf():
    client = APIClient(enforce_csrf_checks=True)
    assert client.post("/api/auth/mode/", {"mode": "developer"}).status_code == 403
    assert client.post("/api/auth/google/start/", {"mode": "developer"}).status_code == 403
    assert client.get("/api/auth/google/start/").status_code == 405


@pytest.mark.parametrize("mode", ["developer", "public"])
def test_selected_mode_is_bound_to_pkce_state_and_fixed_landing(settings, mode):
    settings.SOCIALACCOUNT_PROVIDERS = {
        "google": {
            "APP": {"client_id": "synthetic", "secret": "synthetic", "key": ""},
            "SCOPE": ["openid", "email", "profile"],
            "OAUTH_PKCE_ENABLED": True,
        }
    }
    client = APIClient(enforce_csrf_checks=True)
    client.get("/api/auth/me/")
    token = client.cookies["XSRF-TOKEN"].value
    assert (
        client.post(
            "/api/auth/google/start/", {"mode": "admin"}, HTTP_X_XSRF_TOKEN=token
        ).status_code
        == 400
    )
    response = client.post(
        "/api/auth/google/start/",
        {"mode": mode, "next": "https://evil.invalid"},
        HTTP_X_XSRF_TOKEN=token,
    )
    assert response.status_code == 302
    params = parse_qs(urlsplit(response["Location"]).query)
    assert params["code_challenge_method"] == ["S256"]
    state = client.session["socialaccount_states"][params["state"][0]][0]
    assert state["snapway_mode"] == mode
    assert state["next"] == "/auth/complete"
    assert client.get("/api/auth/me/").json() == {"authenticated": False}


@pytest.mark.parametrize("mode", ["developer", "public"])
def test_verified_social_login_applies_mode_and_preserves_existing_admin(mode):
    user = get_user_model().objects.create_user(username="existing", is_staff=True)
    client = APIClient()
    request = RequestFactory().get("/accounts/google/login/callback/")
    request.session = client.session
    request.user = user
    sociallogin = SocialLogin(user=user)
    sociallogin.state = {"snapway_mode": mode}
    with request_context(request):
        SocialAccountAdapter(request).pre_social_login(request, sociallogin)
        logout(request)  # allauth replaces an existing signed-in session during OAuth.
        AccountAdapter(request).login(request, user)
    assert request.session["snapway_mode"] == mode
    user.refresh_from_db()
    assert user.is_staff
