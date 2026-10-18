from unittest.mock import patch

import pytest
from django.urls import reverse
from rest_framework.test import APIClient

DOCUMENT = {
    "title": "Sam Ibrahim photo points",
    "filename": "points.pdf",
    "sha256": "a" * 64,
    "bytes": 1234,
    "pages": 12,
    "storage_key": "shared/documents/approved/points.pdf",
}


@pytest.fixture
def registry():
    with patch(
        "maps.views_documents.shared_documents", return_value={"sam-ibrahim-points": DOCUMENT}
    ):
        yield


def download():
    return reverse("shared-document-download", kwargs={"slug": "sam-ibrahim-points"})


def test_public_catalog_exposes_metadata_and_stable_link_without_bucket_details(registry):
    response = APIClient().get(reverse("shared-documents"))
    assert response.status_code == 200
    item = response.json()["documents"][0]
    assert item["download_url"] == download()
    assert "storage_key" not in item
    assert response["Cache-Control"] == "no-store"


def test_public_download_gets_fresh_r2_link_without_authentication(registry):
    with (
        patch("maps.views_documents.point_photo_storage_ready", return_value=True),
        patch("maps.views_documents.default_storage.exists", return_value=True) as exists,
        patch(
            "maps.views_documents.signed_url",
            side_effect=["https://r2.example/first", "https://r2.example/second"],
        ) as sign,
    ):
        first = APIClient().get(download())
        second = APIClient().get(download())
    assert first.status_code == second.status_code == 302
    assert first["Location"] != second["Location"]
    assert "no-store" in first["Cache-Control"]
    assert first["Referrer-Policy"] == "no-referrer"
    exists.assert_called_with(DOCUMENT["storage_key"])
    sign.assert_called_with(DOCUMENT["storage_key"])


def test_unknown_id_cannot_sign_another_private_object(registry):
    with patch("maps.views_documents.signed_url") as sign:
        response = APIClient().get(
            reverse("shared-document-download", kwargs={"slug": "private-photos"})
        )
    assert response.status_code == 404
    sign.assert_not_called()


def test_filesystem_fallback_cannot_pretend_the_pdf_is_cloud_stored(registry):
    with (
        patch("maps.views_documents.point_photo_storage_ready", return_value=False),
        patch("maps.views_documents.default_storage.exists") as exists,
    ):
        response = APIClient().get(download())
    assert response.status_code == 503
    exists.assert_not_called()


@pytest.mark.parametrize("exists", [False, RuntimeError("private provider error")])
def test_missing_object_or_provider_failure_is_controlled(registry, exists):
    with (
        patch("maps.views_documents.point_photo_storage_ready", return_value=True),
        patch(
            "maps.views_documents.default_storage.exists",
            **(
                {"side_effect": exists}
                if isinstance(exists, Exception)
                else {"return_value": exists}
            ),
        ),
    ):
        response = APIClient().get(download())
    assert response.status_code == 503
    assert "provider" not in response.content.decode()


def test_public_download_does_not_allow_upload_or_registry_mutation(registry):
    assert APIClient().post(download(), {"storage_key": "private/photo.jpg"}).status_code == 405
