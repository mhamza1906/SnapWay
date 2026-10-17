import pytest
from django.contrib.auth import get_user_model
from django.urls import reverse
from rest_framework.test import APIClient


@pytest.mark.django_db
def test_auth_me_anonymous():
    client = APIClient()
    response = client.get(reverse("auth-me"))
    assert response.status_code == 200
    assert response.json() == {"authenticated": False}


@pytest.mark.django_db
def test_auth_me_authenticated():
    user = get_user_model().objects.create_user(
        username="mapper", email="mapper@example.com", password="not-used-for-oauth"
    )
    client = APIClient()
    client.force_login(user)
    response = client.get(reverse("auth-me"))
    assert response.status_code == 200
    payload = response.json()
    assert payload["authenticated"] is True
    assert payload["id"] == user.pk
    assert payload["username"] == "mapper"
    assert payload["email"] == "mapper@example.com"
    assert payload["is_staff"] is False
    assert payload["is_superuser"] is False


@pytest.mark.django_db
def test_auth_logout_clears_session():
    from django.middleware.csrf import get_token
    from django.test import RequestFactory

    user = get_user_model().objects.create_user(username="volunteer", password="x")
    client = APIClient(enforce_csrf_checks=True)
    client.force_login(user)
    assert client.get(reverse("auth-me")).json()["authenticated"] is True

    request = RequestFactory().get("/")
    request.session = client.session
    token = get_token(request)
    client.cookies["XSRF-TOKEN"] = token
    response = client.post(reverse("auth-logout"), HTTP_X_XSRF_TOKEN=token)
    assert response.status_code == 200
    assert response.json() == {"authenticated": False}
    assert client.get(reverse("auth-me")).json() == {"authenticated": False}


def test_google_login_route_is_mounted():
    assert reverse("google_login") == "/accounts/google/login/"


def test_google_provider_omits_app_without_credentials(settings):
    assert "google" in settings.SOCIALACCOUNT_PROVIDERS
    assert "APP" not in settings.SOCIALACCOUNT_PROVIDERS["google"]
    assert settings.SOCIALACCOUNT_PROVIDERS["google"]["OAUTH_PKCE_ENABLED"] is True
    assert settings.SOCIALACCOUNT_PROVIDERS["google"]["SCOPE"] == [
        "openid",
        "email",
        "profile",
    ]


def test_social_adapter_strips_staff_flags():
    from accounts.adapters import SocialAccountAdapter
    from allauth.socialaccount.models import SocialLogin
    from django.contrib.auth import get_user_model
    from django.test import RequestFactory

    factory = RequestFactory()
    request = factory.get("/")
    user = get_user_model()(
        username="newcomer",
        email="n@example.com",
        is_staff=True,
        is_superuser=True,
    )
    adapter = SocialAccountAdapter()
    populated = adapter.populate_user(
        request, SocialLogin(user=user), {"email": "n@example.com"}
    )
    assert populated.is_staff is False
    assert populated.is_superuser is False
