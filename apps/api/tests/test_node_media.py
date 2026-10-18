import uuid

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
    from io import BytesIO

    from PIL import Image

    out = BytesIO()
    Image.new("RGB", (2, 2), "white").save(out, format="PNG")
    return out.getvalue()


@pytest.fixture
def r2_stub(settings):
    from botocore.stub import Stubber
    from django.core.files.storage import default_storage

    settings.MEDIA_STORAGE_BACKEND = "s3"
    settings.STORAGES = {
        "default": {
            "BACKEND": "storages.backends.s3boto3.S3Boto3Storage",
            "OPTIONS": {
                "access_key": "testing",
                "secret_key": "testing",
                "bucket_name": "test-bucket",
                "endpoint_url": "https://test-account.r2.cloudflarestorage.com",
                "region_name": "auto",
                "signature_version": "s3v4",
                "default_acl": None,
                "file_overwrite": True,
            },
        },
    }
    with Stubber(default_storage.connection.meta.client) as stub:
        yield stub
        stub.assert_no_pending_responses()


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


@pytest.mark.django_db
def test_directional_photos_one_per_direction_in_r2(actors, draft, settings, tmp_path, r2_stub):
    # Exercise the real S3 storage adapter/signing, stubbing only the remote API.
    settings.MEDIA_ROOT = tmp_path
    settings.MEDIA_STORAGE_BACKEND = "s3"
    from maps.models import Revision

    revision = Revision.objects.get(pk=draft["revision_id"])
    node = add_node(revision, x=5, y=5, label="Point 1", actor=actors["member"])
    client = APIClient()
    client.force_login(actors["member"])
    url = reverse(
        "map-revision-node-photos",
        kwargs={"revision_id": draft["revision_id"], "node_id": node.id},
    )

    def send(direction):
        if direction in ("front", "right", "back", "left"):
            r2_stub.add_client_error("head_object", service_error_code="404", http_status_code=404)
            r2_stub.add_response("put_object", {})
        return client.post(
            url,
            {
                "file": SimpleUploadedFile("p.png", _tiny_png(), content_type="image/png"),
                "direction": direction,
            },
            format="multipart",
        )

    for direction in ("front", "right", "back", "left"):
        assert send(direction).status_code == 201
    replaced = send("front")
    assert replaced.status_code == 201 and replaced.json()["direction"] == "front"
    assert "test-account.r2.cloudflarestorage.com" in replaced.json()["url"]
    assert "X-Amz-Signature=" in replaced.json()["url"]
    photos = client.get(url).json()["photos"]
    assert sorted(p["direction"] for p in photos) == ["back", "front", "left", "right"]
    assert replaced.json()["id"] in {p["id"] for p in photos}
    assert send("up").status_code == 400
    assert not list(tmp_path.rglob("*.png"))


@pytest.mark.django_db
def test_directional_upload_failure_preserves_previous_view(actors, draft, r2_stub):
    from maps.models import Asset, ReferencePhoto, Revision
    from maps.services.references import PhotoStorageUnavailable, attach_node_photo

    revision = Revision.objects.get(pk=draft["revision_id"])
    node = add_node(revision, x=1, y=2, actor=actors["member"])

    def upload(data):
        return attach_node_photo(
            revision,
            node_id=node.id,
            actor=actors["member"],
            uploaded_file=SimpleUploadedFile("x.png", data, "image/png"),
            direction="front",
        )

    r2_stub.add_client_error("head_object", service_error_code="404", http_status_code=404)
    r2_stub.add_response("put_object", {})
    first = upload(_tiny_png())
    r2_stub.add_client_error("head_object", service_error_code="403", http_status_code=403)
    with pytest.raises(PhotoStorageUnavailable):
        upload(_tiny_png())
    from maps.services.graph import GraphError

    with pytest.raises(GraphError, match="valid PNG"):
        upload(b"not an image")
    assert list(ReferencePhoto.objects.filter(node=node).values_list("id", flat=True)) == [
        uuid.UUID(first["id"])
    ]
    assert Asset.objects.filter(pk=first["asset_id"]).exists()


@pytest.mark.django_db
def test_directional_photos_refused_without_r2(actors, draft, settings, tmp_path):
    settings.MEDIA_ROOT = tmp_path
    settings.MEDIA_STORAGE_BACKEND = "filesystem"
    from maps.models import Revision

    revision = Revision.objects.get(pk=draft["revision_id"])
    node = add_node(revision, x=5, y=5, actor=actors["member"])
    client = APIClient()
    client.force_login(actors["member"])
    response = client.post(
        reverse(
            "map-revision-node-photos",
            kwargs={"revision_id": draft["revision_id"], "node_id": node.id},
        ),
        {
            "file": SimpleUploadedFile("p.png", _tiny_png(), content_type="image/png"),
            "direction": "front",
        },
        format="multipart",
    )
    assert response.status_code == 503
    assert "Cloudflare R2" in response.json()["detail"]
    assert not list(tmp_path.rglob("*.png"))
