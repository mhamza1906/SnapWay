import pytest
from django.contrib.auth import get_user_model
from django.core.files.uploadedfile import SimpleUploadedFile
from django.urls import reverse
from maps.services.draft import ensure_demo_draft
from maps.services.graph import add_node, freeze_revision
from rest_framework.test import APIClient

User = get_user_model()


@pytest.fixture
def actors(db):
    member = User.objects.create_user(username="member", email="member@example.com", password="x")
    stranger = User.objects.create_user(
        username="stranger", email="stranger@example.com", password="x"
    )
    return {"member": member, "stranger": stranger}


@pytest.fixture
def draft(actors):
    return ensure_demo_draft(actors["member"])


def _tiny_png() -> bytes:
    return (
        b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01"
        b"\x08\x02\x00\x00\x00\x90wS\xde\x00\x00\x00\x0cIDATx\x9cc\xf8\x0f"
        b"\x00\x00\x01\x01\x00\x05\x18\xd8N\x00\x00\x00\x00IEND\xaeB`\x82"
    )


@pytest.mark.django_db
def test_patch_node_label(actors, draft):
    from maps.models import Revision

    revision = Revision.objects.get(pk=draft["revision_id"])
    node = add_node(revision, x=10, y=20, label="Old", actor=actors["member"])
    client = APIClient()
    client.force_login(actors["member"])
    response = client.patch(
        reverse(
            "map-revision-node-detail",
            kwargs={"revision_id": draft["revision_id"], "node_id": node.id},
        ),
        {"label": "Studio 101"},
        format="json",
    )
    assert response.status_code == 200
    assert response.json()["label"] == "Studio 101"
    node.refresh_from_db()
    assert node.label == "Studio 101"


@pytest.mark.django_db
def test_stranger_cannot_patch_label(actors, draft):
    from maps.models import Revision

    revision = Revision.objects.get(pk=draft["revision_id"])
    node = add_node(revision, x=1, y=2, actor=actors["member"])
    client = APIClient()
    client.force_login(actors["stranger"])
    response = client.patch(
        reverse(
            "map-revision-node-detail",
            kwargs={"revision_id": draft["revision_id"], "node_id": node.id},
        ),
        {"label": "Nope"},
        format="json",
    )
    assert response.status_code == 403


@pytest.mark.django_db
def test_frozen_rejects_label_update(actors, draft):
    from maps.models import Revision

    revision = Revision.objects.get(pk=draft["revision_id"])
    node = add_node(revision, x=1, y=2, actor=actors["member"])
    freeze_revision(revision)
    client = APIClient()
    client.force_login(actors["member"])
    response = client.patch(
        reverse(
            "map-revision-node-detail",
            kwargs={"revision_id": draft["revision_id"], "node_id": node.id},
        ),
        {"label": "Frozen"},
        format="json",
    )
    assert response.status_code == 400


@pytest.mark.django_db
def test_attach_list_delete_node_photo(actors, draft, settings, tmp_path):
    settings.MEDIA_ROOT = tmp_path
    from maps.models import Revision

    revision = Revision.objects.get(pk=draft["revision_id"])
    node = add_node(revision, x=5, y=5, label="Door", actor=actors["member"])
    client = APIClient()
    client.force_login(actors["member"])
    photos_url = reverse(
        "map-revision-node-photos",
        kwargs={"revision_id": draft["revision_id"], "node_id": node.id},
    )
    upload = client.post(
        photos_url,
        {"file": SimpleUploadedFile("ref.png", _tiny_png(), content_type="image/png")},
        format="multipart",
    )
    assert upload.status_code == 201
    body = upload.json()
    assert body["url"]
    assert body["id"]

    listed = client.get(photos_url)
    assert listed.status_code == 200
    assert len(listed.json()["photos"]) == 1

    from maps.models import Asset, ReferencePhoto

    asset_id = body["asset_id"]
    deleted = client.delete(
        reverse(
            "map-revision-photo-detail",
            kwargs={"revision_id": draft["revision_id"], "photo_id": body["id"]},
        )
    )
    assert deleted.status_code == 204
    assert client.get(photos_url).json()["photos"] == []
    # Asset is append-only: association is removed, Asset row remains.
    assert not ReferencePhoto.objects.filter(pk=body["id"]).exists()
    assert Asset.objects.filter(pk=asset_id).exists()


@pytest.mark.django_db
def test_underlay_uses_media_store(actors, draft, settings, tmp_path):
    settings.MEDIA_ROOT = tmp_path
    client = APIClient()
    client.force_login(actors["member"])
    response = client.post(
        reverse("map-revision-underlay", kwargs={"revision_id": draft["revision_id"]}),
        {"file": SimpleUploadedFile("plan.png", _tiny_png(), content_type="image/png")},
        format="multipart",
    )
    assert response.status_code == 201
    assert response.json()["underlay_url"]
    assert "underlays/" in response.json()["underlay_url"] or response.json()[
        "underlay_url"
    ].startswith("/")
