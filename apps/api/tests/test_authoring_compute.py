"""Only developer sessions can run the allowlisted, stateless manual tools."""

from unittest.mock import patch

import httpx
import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

pytestmark = pytest.mark.django_db
BASE = "/api/maps/authoring-compute/"


def developer():
    user = get_user_model().objects.create_user(username="authoring-user")
    client = APIClient(enforce_csrf_checks=True)
    client.force_login(user)
    session = client.session
    session["snapway_mode"] = "developer"
    session.save()
    client.get("/api/auth/me/")
    return client


def test_project_access_and_manual_operations_require_developer_and_csrf():
    client = APIClient(enforce_csrf_checks=True)
    assert client.get(BASE + "buildings/sam-ibrahim").status_code == 403
    client = developer()
    assert client.post(BASE + "authoring/render", {}, format="json").status_code == 403
    session = client.session
    session["snapway_mode"] = "public"
    session.save()
    assert client.get(BASE + "buildings/sam-ibrahim").status_code == 403


def test_bundled_project_is_downloadable_without_private_compute_or_database_maps():
    client = developer()
    response = client.get(BASE + "buildings/sam-ibrahim?download=1")
    assert response.status_code == 200
    assert response.json()["id"] == "sam-ibrahim-hardcoded"
    assert len(response.json()["floors"]) == 6
    assert "attachment" in response["Content-Disposition"]
    assert client.get(BASE + "buildings").json()["buildings"][0]["key"] == "sam-ibrahim"
    assert client.get(BASE + "buildings/editor-save").status_code == 404


def test_compute_forwards_only_allowed_operation_and_no_browser_credentials():
    client = developer()
    with patch("maps.views_authoring.httpx.Client") as factory:
        upstream = factory.return_value.__enter__.return_value
        upstream.request.return_value = httpx.Response(200, json={"svg": "<svg/>"})
        response = client.post(
            BASE + "authoring/render",
            {"building": {}},
            format="json",
            HTTP_X_XSRF_TOKEN=client.cookies["XSRF-TOKEN"].value,
        )
        assert response.status_code == 200
        assert response.json() == {"svg": "<svg/>"}
        upstream.request.assert_called_once_with(
            "POST", "http://127.0.0.1:5175/api/authoring/render", json={"building": {}}
        )
        factory.assert_called_once_with(timeout=45, trust_env=False, follow_redirects=False)
    for operation in ("../../project", "project", "map-jobs/other-user", "buildings/other"):
        assert (
            client.post(
                BASE + operation,
                {},
                format="json",
                HTTP_X_XSRF_TOKEN=client.cookies["XSRF-TOKEN"].value,
            ).status_code
            == 404
        )


def test_compute_failure_has_no_private_details_and_paid_jobs_are_disabled():
    client = developer()
    with patch("maps.views_authoring.httpx.Client") as factory:
        factory.return_value.__enter__.return_value.request.side_effect = httpx.ConnectError(
            "secret"
        )
        response = client.get(BASE + "health")
        assert response.status_code == 503 and "secret" not in str(response.data)
    assert (
        client.post(
            BASE + "map-jobs",
            {},
            format="json",
            HTTP_X_XSRF_TOKEN=client.cookies["XSRF-TOKEN"].value,
        ).status_code
        == 503
    )
