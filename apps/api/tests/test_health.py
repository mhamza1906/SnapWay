from unittest.mock import patch

import pytest
from django.db import OperationalError
from django.urls import reverse


def test_liveness_does_not_require_database(client):
    with patch(
        "config.views.connection.cursor", side_effect=OperationalError("private connection")
    ):
        response = client.get(reverse("liveness"))
    assert response.status_code == 200
    assert response.json()["service"] == "snapway-api"


@pytest.mark.django_db
def test_readiness_requires_migrated_database(client):
    assert client.get(reverse("readiness")).status_code == 200


def test_database_failure_is_unavailable_without_leaking_details(client):
    with patch(
        "config.views.connection.cursor", side_effect=OperationalError("private connection")
    ):
        response = client.get(reverse("readiness"))
    assert response.status_code == 503
    assert b"private connection" not in response.content


def test_unsafe_health_method_is_rejected(client):
    assert client.post(reverse("liveness")).status_code == 405
