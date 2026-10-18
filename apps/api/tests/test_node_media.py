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


@pytest.mark.django_db
def test_phone_draft_list_is_scoped_and_graph_reports_saved_views(
    actors, draft, settings, tmp_path
):
    from maps.models import Asset, ReferencePhoto, Revision

    settings.MEDIA_ROOT = tmp_path
    revision = Revision.objects.get(pk=draft["revision_id"])
    node = add_node(revision, x=1, y=2, label="Point 1", actor=actors["member"])
    asset = Asset.objects.create(
        target=revision.target,
        uploaded_by=actors["member"],
        kind="photo",
        storage_key="test.png",
        content_type="image/png",
        sha256="a" * 64,
        byte_size=1,
    )
    for direction in ["front", "right"]:
        ReferencePhoto.objects.create(
            revision=revision, node=node, asset=asset, capture_context={"direction": direction}
        )
    client = APIClient()
    client.force_login(actors["member"])
    listed = client.get(reverse("map-draft-ensure"))
    assert listed.status_code == 200
    assert [d["target_id"] for d in listed.json()["drafts"]] == [str(revision.target_id)]
    graph = client.get(reverse("map-revision-graph", kwargs={"revision_id": revision.id})).json()
    assert graph["nodes"][0]["photo_directions"] == ["front", "right"]
    assert graph["photo_uploads_available"] is False
    client.force_login(actors["stranger"])
    assert client.get(reverse("map-draft-ensure")).json()["drafts"] == []


@pytest.mark.django_db
def test_import_phone_walks_preserves_existing_draft_on_repeat(actors, settings, tmp_path):
    import base64
    import io
    import json

    from django.core.management import call_command
    from maps.models import Contribution

    settings.MEDIA_ROOT = tmp_path
    source = tmp_path / "walk.json"
    source.write_text(
        json.dumps(
            {
                "walks": [
                    {
                        "source": "test-svg:floor:circulation:12",
                        "title": "Test circulation",
                        "floor": "Level 2",
                        "width": 100,
                        "height": 100,
                        "points": 1,
                        "underlay": base64.b64encode(_tiny_png()).decode(),
                        "nodes": [{"x": 5, "y": 10, "label": "Point 1", "kind": "checkpoint"}],
                        "edges": [],
                    }
                ]
            }
        )
    )
    for _ in range(2):
        call_command(
            "import_photo_walks", username="member", file=str(source), stdout=io.StringIO()
        )
    contributions = Contribution.objects.filter(author=actors["member"])
    assert contributions.count() == 1
    revision = contributions.get().head_revision
    assert revision.nodes.count() == 1
    assert revision.geometry["photo_walk_source"] == "test-svg:floor:circulation:12"
    actors["member"].refresh_from_db()
    assert not actors["member"].is_staff


@pytest.fixture
def walk_expansion(actors, draft, tmp_path):
    import json

    from maps.models import Asset, ReferencePhoto, Revision
    from maps.services.graph import add_edge

    revision = Revision.objects.get(pk=draft["revision_id"])
    revision.geometry = {"photo_walk_source": "test:floor:hall:12", "review": "agent-inspected"}
    revision.coordinate_frame = {"width": 100, "height": 100, "origin": "top_left", "units": "plan"}
    revision.save()
    first = add_node(revision, x=0, y=10, label="Point 1", actor=actors["member"])
    last = add_node(revision, x=19, y=10, label="Point 2", actor=actors["member"])
    add_edge(revision, actor=actors["member"], from_id=first.id, to_id=last.id)
    asset = Asset.objects.create(
        target=revision.target,
        uploaded_by=actors["member"],
        kind="photo",
        storage_key="existing-photo.png",
        content_type="image/png",
        sha256="b" * 64,
        byte_size=1,
    )
    photo = ReferencePhoto.objects.create(
        revision=revision, node=last, asset=asset, capture_context={"direction": "front"}
    )
    source = tmp_path / "expanded.json"
    source.write_text(
        json.dumps(
            {
                "walks": [
                    {
                        "source": "test:floor:hall:20",
                        "previousSource": "test:floor:hall:12",
                        "width": 100,
                        "height": 100,
                        "points": 20,
                        "nodes": [
                            {"x": i, "y": 10, "label": f"Point {i + 1}", "kind": "checkpoint"}
                            for i in range(20)
                        ],
                        "edges": [{"from": i, "to": i + 1} for i in range(19)],
                    }
                ]
            }
        )
    )
    return revision, first, last, photo, source


@pytest.mark.django_db
@pytest.mark.parametrize("count", [20, 30])
def test_expand_saved_walk_preserves_node_ids_and_photos(walk_expansion, count):
    import io
    import json

    from django.core.management import call_command
    from maps.models import Contribution

    revision, first, last, photo, source = walk_expansion
    data = json.loads(source.read_text())
    walk = data["walks"][0]
    walk["source"] = f"test:floor:hall:{count}"
    walk["points"] = count
    walk["nodes"] = [
        {"x": i, "y": 10, "label": f"Point {i + 1}", "kind": "checkpoint"} for i in range(count)
    ]
    walk["edges"] = [{"from": i, "to": i + 1} for i in range(count - 1)]
    source.write_text(json.dumps(data))
    for _ in range(2):
        call_command(
            "import_photo_walks",
            username="member",
            file=str(source),
            upgrade_existing=True,
            stdout=io.StringIO(),
        )
    revision.refresh_from_db()
    last.refresh_from_db()
    photo.refresh_from_db()
    assert Contribution.objects.count() == 1
    assert revision.nodes.count() == count
    assert revision.edges.count() == count - 1
    assert revision.nodes.filter(pk=first.id).exists()
    assert last.label == "Point 20"
    assert (last.x, last.y) == (19, 10)
    assert photo.node_id == last.id
    assert photo.capture_context == {"direction": "front"}
    assert revision.geometry["photo_walk_source"] == f"test:floor:hall:{count}"
    assert revision.geometry["review"] == "agent-inspected"


@pytest.mark.django_db
def test_expand_saved_walk_refuses_to_move_existing_photo_locations(walk_expansion):
    import io
    import json

    from django.core.management import call_command
    from django.core.management.base import CommandError

    revision, _, last, photo, source = walk_expansion
    data = json.loads(source.read_text())
    data["walks"][0]["nodes"][-1]["x"] = 18.5
    source.write_text(json.dumps(data))
    with pytest.raises(CommandError, match="retain every existing node"):
        call_command(
            "import_photo_walks",
            username="member",
            file=str(source),
            upgrade_existing=True,
            stdout=io.StringIO(),
        )
    revision.refresh_from_db()
    last.refresh_from_db()
    photo.refresh_from_db()
    assert revision.nodes.count() == 2
    assert revision.edges.count() == 1
    assert last.label == "Point 2"
    assert photo.node_id == last.id
    assert revision.geometry["photo_walk_source"] == "test:floor:hall:12"


@pytest.mark.django_db
def test_adaptive_replan_keeps_unused_photo_nodes_and_their_photos(walk_expansion):
    import io
    import json

    from django.core.management import call_command
    from maps.services.graph import list_graph

    revision, _, last, photo, source = walk_expansion
    data = json.loads(source.read_text())
    walk = data["walks"][0]
    walk["points"] = 2
    walk["previousSources"] = [walk.pop("previousSource")]
    for i, node in enumerate(walk["nodes"]):
        node["label"] = "Point 1" if i == 0 else "Point 2" if i == 15 else "Path junction / bend"
    source.write_text(json.dumps(data))
    call_command(
        "import_photo_walks",
        username="member",
        file=str(source),
        upgrade_existing=True,
        stdout=io.StringIO(),
    )
    revision.refresh_from_db()
    photo.refresh_from_db()
    assert revision.nodes.count() == 20
    assert revision.nodes.filter(label__startswith="Point ").count() == 2
    assert photo.node_id == last.id
    graph_node = next(node for node in list_graph(revision)["nodes"] if node["id"] == str(last.id))
    assert graph_node["photo_directions"] == ["front"]
    assert graph_node["label"] == "Path junction / bend"
